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

    for entry in walker.flatten() {
        let path = entry.path();

        // Skip directories
        if path.is_dir() {
            continue;
        }

        // Skip known non-source directories (deployment artifacts, build output, etc.)
        let path_str = path.to_string_lossy();
        if path_str.contains("/deployments/")
            || path_str.contains("/artifacts/")
            || path_str.contains("/cache/")
            || path_str.contains("/out/")
            || path_str.contains("/typechain-types/")
        {
            continue;
        }

        // Skip files we can't read
        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Skip files larger than 1MB (binary files, bundles, etc.)
        if metadata.len() > 1_000_000 {
            continue;
        }

        // Detect language from extension
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let language = Language::from_extension(ext);

        // Only include parseable source files
        if !language.is_parseable() {
            continue;
        }

        // Build relative path
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        // Skip common non-source directories that might slip through
        if relative.starts_with("node_modules/")
            || relative.starts_with(".git/")
            || relative.starts_with("target/")
            || relative.starts_with("dist/")
            || relative.starts_with("build/")
            || relative.starts_with(".next/")
            || relative.contains("/node_modules/")
            || relative.starts_with("vendor/")      // Go vendor directory
            || relative.contains("/vendor/")
            || relative.starts_with(".gradle/")     // Java Gradle cache
        {
            continue;
        }

        files.push(SourceFile {
            path: path.to_path_buf(),
            relative_path: relative,
            language,
            size: metadata.len(),
        });
    }

    // Sort by path for deterministic ordering
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    files
}

/// Detect project framework from config files and dependencies.
pub fn detect_framework(root: &Path) -> Option<String> {
    // Check package.json
    let pkg_path = root.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_path) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            let deps = pkg.get("dependencies")
                .and_then(|d| d.as_object())
                .map(|d| d.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();

            if deps.iter().any(|d| d == "next") { return Some("Next.js".to_string()); }
            if deps.iter().any(|d| d == "nuxt") { return Some("Nuxt".to_string()); }
            if deps.iter().any(|d| d == "svelte") { return Some("Svelte".to_string()); }
            if deps.iter().any(|d| d == "vue") { return Some("Vue".to_string()); }
            if deps.iter().any(|d| d == "react") { return Some("React".to_string()); }
            if deps.iter().any(|d| d == "express") { return Some("Express".to_string()); }
            if deps.iter().any(|d| d == "fastify") { return Some("Fastify".to_string()); }
        }
    }

    // Check Cargo.toml
    if root.join("Cargo.toml").exists() {
        return Some("Rust".to_string());
    }

    // Check pyproject.toml or setup.py
    if root.join("pyproject.toml").exists() || root.join("setup.py").exists() {
        return Some("Python".to_string());
    }

    // Solidity — foundry or hardhat
    if root.join("foundry.toml").exists() {
        return Some("Solidity/Foundry".to_string());
    }
    if root.join("hardhat.config.js").exists() || root.join("hardhat.config.ts").exists() {
        return Some("Solidity/Hardhat".to_string());
    }

    // Go
    if root.join("go.mod").exists() {
        return Some("Go".to_string());
    }

    // Java
    if root.join("pom.xml").exists() {
        return Some("Java/Maven".to_string());
    }
    if root.join("build.gradle").exists() || root.join("build.gradle.kts").exists() {
        return Some("Java/Gradle".to_string());
    }

    // Ruby
    if root.join("Gemfile").exists() {
        return Some("Ruby".to_string());
    }

    // C/C++
    if root.join("CMakeLists.txt").exists() {
        return Some("C/C++".to_string());
    }

    None
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
pub fn find_entry_points(root: &Path) -> Vec<String> {
    let candidates = [
        "src/main.tsx", "src/main.ts", "src/index.tsx", "src/index.ts",
        "src/main.rs", "src/lib.rs",
        "src/app.py", "main.py", "app.py",
        "index.html", "index.js", "index.ts",
        "main.go", "cmd/main.go",
        "Main.java", "src/main/java/Main.java",
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
