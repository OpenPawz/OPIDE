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

    // Walk files respecting .gitignore
    let walker = WalkBuilder::new(&request.root)
        .hidden(true)          // skip hidden files
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

        // Skip known large non-source directories that blow up context
        let path_str_check = path.to_string_lossy();
        if path_str_check.contains("/deployments/")
            || path_str_check.contains("/artifacts/")
            || path_str_check.contains("/cache/")
            || path_str_check.contains("/cache_forge/")
            || path_str_check.contains("/out/")
            || path_str_check.contains("/typechain-types/")
            || path_str_check.contains("/node_modules/")
        {
            continue;
        }

        // Skip files larger than 500KB to prevent context blowouts
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 500_000 {
                continue;
            }
        }

        // Apply glob filter if provided
        if let Some(ref glob) = request.glob {
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !glob_match(glob, file_name) {
                continue;
            }
        }

        let path_str = path.to_string_lossy().to_string();
        // Strip the root prefix for cleaner display
        let relative = path_str
            .strip_prefix(&request.root)
            .unwrap_or(&path_str)
            .trim_start_matches('/');

        let relative_owned = relative.to_string();

        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_number, line_text| {
                if all_matches.len() < max_results {
                    all_matches.push(SearchMatch {
                        path: relative_owned.clone(),
                        line_number,
                        line_text: line_text.trim_end().to_string(),
                    });
                }
                Ok(all_matches.len() < max_results)
            }),
        );

        if all_matches.len() >= max_results {
            break;
        }
    }

    let total = all_matches.len();
    let truncated = total >= max_results;

    Ok(SearchResult {
        matches: all_matches,
        total_matches: total,
        truncated,
    })
}

#[tauri::command]
pub async fn search_file_list(root: String, max_results: Option<usize>) -> Result<Vec<String>, String> {
    let max = max_results.unwrap_or(5000);

    let walker = WalkBuilder::new(&root)
        .hidden(true)
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

        let path = entry.path().to_string_lossy().to_string();
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .trim_start_matches('/')
            .to_string();

        files.push(relative);

        if files.len() >= max {
            break;
        }
    }

    Ok(files)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Simple glob matching — supports * and ? wildcards
fn glob_match(pattern: &str, name: &str) -> bool {
    // Convert simple glob to regex
    let regex_str = pattern
        .replace('.', "\\.")
        .replace('*', ".*")
        .replace('?', ".");
    regex::Regex::new(&format!("^{regex_str}$"))
        .map(|re| re.is_match(name))
        .unwrap_or(false)
}
