// ── File Scanner ─────────────────────────────────────────────────────────────
// Walks a workspace directory, respects .gitignore, detects file languages.
// Returns a list of source files to parse.

use super::types::Language;
use std::path::{Path, PathBuf};

/// A source file found during scanning.
pub struct SourceFile {
    pub path: PathBuf,
    pub relative_path: String,
    pub language: Language,
    pub size: u64,
    /// B182: when the file exceeds EMBED_CAP we still parse its symbols
    /// and dependencies but skip generating an embedding for it. AST
    /// queries still work; semantic search ignores it.
    pub skip_embedding: bool,
}

/// Scan a workspace directory for source files.
/// Respects .gitignore via the `ignore` crate (already a dependency).
pub fn scan_workspace(root: &Path) -> Vec<SourceFile> {
    let mut files = Vec::new();

    // Use the `ignore` crate's WalkBuilder which respects .gitignore
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)          // skip hidden files
        .git_ignore(true)      // respect .gitignore
        .git_global(true)      // respect global gitignore
        .git_exclude(true)     // respect .git/info/exclude
        .max_depth(Some(20))   // don't recurse infinitely
        .build();

    // B181: consolidated trailing-segment matcher. Names hit anywhere in
    // the path tree (so `/foo/node_modules/bar/baz.js` skips even if it
    // wasn't the relative-prefix). The previous code split the check
    // between substring and `relative.starts_with` which both leaked
    // (e.g. `cache/x.ts` at the root passed the relative-prefix check
    // but caught the substring; nested `vendor/` was missed by some).
    const SKIP_DIR_NAMES: &[&str] = &[
        "node_modules", ".git", "target", "dist", "build", ".next", ".nuxt",
        "vendor", ".gradle", "out", ".cache", "bazel-out", ".bazel",
        ".idea", ".svn", ".hg", "__pycache__", "venv", ".venv", "env",
        "coverage", ".nyc_output", ".parcel-cache", ".swc", ".turbo",
        ".terraform", ".pytest_cache", ".mypy_cache", ".ruff_cache",
        // Solidity / Foundry / Hardhat
        "deployments", "artifacts", "cache_forge", "typechain-types",
    ];

    // B182: two-tier file size policy.
    //   - HARD_CAP: completely skip (binary files, bundles, gigantic generated code)
    //   - EMBED_CAP: still index symbols/structure, but mark `skip_embedding`
    //     so embeddings don't waste tokens on huge files.
    const HARD_CAP: u64 = 5_000_000;
    const EMBED_CAP: u64 = 1_000_000;

    for entry in walker.flatten() {
        let path = entry.path();

        if path.is_dir() {
            continue;
        }

        // Skip if any path component matches a skip-dir name.
        let in_skip_dir = path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| SKIP_DIR_NAMES.iter().any(|skip| s == *skip))
                .unwrap_or(false)
        });
        if in_skip_dir {
            continue;
        }

        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.len() > HARD_CAP {
            continue;
        }
        let skip_embedding = metadata.len() > EMBED_CAP;

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let language = Language::from_extension(ext);
        if !language.is_parseable() {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        files.push(SourceFile {
            path: path.to_path_buf(),
            relative_path: relative,
            language,
            size: metadata.len(),
            skip_embedding,
        });
    }

    // Sort by path for deterministic ordering
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    files
}

/// Detect project frameworks from config files and dependencies.
///
/// B184: returns *all* detected frameworks instead of the first match.
/// Many real projects are polyglot (a Next.js app with a Tailwind UI and
/// a Solidity contracts/ subdir, a Rust workspace that also ships a
/// React frontend), so reporting only the first hit hid relevant context
/// from the agent.
pub fn detect_frameworks(root: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    let pkg_path = root.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_path) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            let mut deps_set: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for key in &["dependencies", "devDependencies"] {
                if let Some(d) = pkg.get(key).and_then(|d| d.as_object()) {
                    for k in d.keys() {
                        deps_set.insert(k.clone());
                    }
                }
            }
            // Order matters: most specific stack wins the framework name,
            // generic libs come after.
            if deps_set.contains("astro") {
                found.push("Astro".into());
            }
            if deps_set.contains("@sveltejs/kit") {
                found.push("SvelteKit".into());
            } else if deps_set.contains("svelte") {
                found.push("Svelte".into());
            }
            if deps_set.contains("next") {
                found.push("Next.js".into());
            }
            if deps_set.contains("nuxt") {
                found.push("Nuxt".into());
            }
            if deps_set.contains("@remix-run/react") {
                found.push("Remix".into());
            }
            if deps_set.contains("solid-js") {
                found.push("SolidJS".into());
            }
            if deps_set.contains("react") && !deps_set.contains("next") {
                found.push("React".into());
            }
            if deps_set.contains("vue") && !deps_set.contains("nuxt") {
                found.push("Vue".into());
            }
            if deps_set.contains("express") {
                found.push("Express".into());
            }
            if deps_set.contains("fastify") {
                found.push("Fastify".into());
            }
            if deps_set.contains("tailwindcss") {
                found.push("Tailwind".into());
            }
        }
    }
    if root.join("Cargo.toml").exists() {
        found.push("Rust".into());
    }
    if root.join("pyproject.toml").exists() || root.join("setup.py").exists() {
        found.push("Python".into());
    }
    if root.join("foundry.toml").exists() {
        found.push("Solidity/Foundry".into());
    }
    if root.join("hardhat.config.js").exists() || root.join("hardhat.config.ts").exists() {
        found.push("Solidity/Hardhat".into());
    }
    if root.join("go.mod").exists() {
        found.push("Go".into());
    }
    if root.join("pom.xml").exists() {
        found.push("Java/Maven".into());
    }
    if root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        found.push("Java/Gradle".into());
    }
    if root.join("Gemfile").exists() {
        found.push("Ruby".into());
    }
    if root.join("CMakeLists.txt").exists() {
        found.push("C/C++".into());
    }
    found
}

/// Backwards-compatible single-framework wrapper. ProjectIndex.framework
/// is still `Option<String>`; callers that want the full set should
/// switch to `detect_frameworks` directly.
pub fn detect_framework(root: &Path) -> Option<String> {
    detect_frameworks(root).into_iter().next()
}

/// Extract package dependencies from package.json or Cargo.toml.
pub fn extract_package_deps(root: &Path) -> Vec<String> {
    let pkg_path = root.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_path) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            let mut deps = Vec::new();
            if let Some(d) = pkg.get("dependencies").and_then(|d| d.as_object()) {
                deps.extend(d.keys().cloned());
            }
            if let Some(d) = pkg.get("devDependencies").and_then(|d| d.as_object()) {
                deps.extend(d.keys().cloned());
            }
            deps.sort();
            return deps;
        }
    }

    Vec::new()
}

/// Find entry point files.
/// B183: extended the candidate list with modern-framework entry points
/// (Astro, SvelteKit, Next.js app/, Remix, Nuxt 3, SolidStart) and added
/// JSX/JS variants so React projects without TS still resolve.
pub fn find_entry_points(root: &Path) -> Vec<String> {
    let candidates = [
        // React / Vite / generic JS/TS
        "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
        "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
        // Astro
        "src/pages/index.astro", "astro.config.mjs", "astro.config.ts",
        // SvelteKit
        "src/routes/+page.svelte", "src/app.html",
        // Next.js (app router + pages router)
        "app/page.tsx", "app/page.jsx", "pages/index.tsx", "pages/index.jsx", "pages/_app.tsx",
        // Remix / SolidStart
        "app/root.tsx", "src/entry-server.tsx",
        // Nuxt
        "app.vue", "nuxt.config.ts",
        // Rust
        "src/main.rs", "src/lib.rs",
        // Python
        "src/app.py", "main.py", "app.py", "src/__init__.py",
        // Web
        "index.html", "public/index.html", "index.js", "index.ts",
        // Go
        "main.go", "cmd/main.go",
        // Java
        "Main.java", "src/main/java/Main.java",
        // Ruby
        "config.ru", "app.rb",
    ];

    candidates
        .iter()
        .filter(|c| root.join(c).exists())
        .map(|c| c.to_string())
        .collect()
}

/// Find config files.
pub fn find_config_files(root: &Path) -> Vec<String> {
    let candidates = [
        "package.json", "tsconfig.json", "tsconfig.node.json",
        "vite.config.ts", "vite.config.js",
        "vitest.config.ts", "jest.config.ts", "jest.config.js",
        "next.config.js", "next.config.ts",
        "tailwind.config.ts", "tailwind.config.js",
        "postcss.config.js", "postcss.config.cjs",
        ".eslintrc.js", ".eslintrc.json", "eslint.config.js",
        ".prettierrc", ".prettierrc.json",
        "Cargo.toml", "Cargo.lock",
        "pyproject.toml", "setup.py", "requirements.txt",
        "foundry.toml", "hardhat.config.js", "hardhat.config.ts", "truffle-config.js",
        "go.mod", "go.sum",
        "pom.xml", "build.gradle", "build.gradle.kts",
        "Gemfile", "Gemfile.lock",
        "CMakeLists.txt", "Makefile",
    ];

    candidates
        .iter()
        .filter(|c| root.join(c).exists())
        .map(|c| c.to_string())
        .collect()
}
