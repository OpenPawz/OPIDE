// ── Indexer Types ────────────────────────────────────────────────────────────
// Data structures for the codebase index: files, symbols, imports, exports.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Language ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Language {
    TypeScript,
    TypeScriptReact,
    JavaScript,
    JavaScriptReact,
    Rust,
    Python,
    Css,
    Json,
    Solidity,
    Move,
    Go,
    C,
    Cpp,
    Java,
    Ruby,
    Cobol,
    Fortran,
    Unknown,
}

impl Language {
    pub fn from_extension(ext: &str) -> Self {
        match ext {
            "ts" => Language::TypeScript,
            "tsx" => Language::TypeScriptReact,
            "js" | "mjs" | "cjs" => Language::JavaScript,
            "jsx" => Language::JavaScriptReact,
            "rs" => Language::Rust,
            "py" => Language::Python,
            "css" | "scss" | "less" => Language::Css,
            "json" => Language::Json,
            "sol" | "yul" => Language::Solidity,
            "move" => Language::Move,
            "go" => Language::Go,
            "c" | "h" => Language::C,
            "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "h++" => Language::Cpp,
            "java" => Language::Java,
            "rb" => Language::Ruby,
            "cbl" | "cob" | "cobol" | "cpy" => Language::Cobol,
            "f" | "f77" | "f90" | "f95" | "f03" | "f08" | "for" | "ftn" => Language::Fortran,
            _ => Language::Unknown,
        }
    }

    pub fn is_parseable(&self) -> bool {
        !matches!(self, Language::Unknown)
    }

    pub fn label(&self) -> &'static str {
        match self {
            Language::TypeScript => "TypeScript",
            Language::TypeScriptReact => "TypeScript React",
            Language::JavaScript => "JavaScript",
            Language::JavaScriptReact => "JavaScript React",
            Language::Rust => "Rust",
            Language::Python => "Python",
            Language::Css => "CSS",
            Language::Json => "JSON",
            Language::Solidity => "Solidity",
            Language::Move => "Move",
            Language::Go => "Go",
            Language::C => "C",
            Language::Cpp => "C++",
            Language::Java => "Java",
            Language::Ruby => "Ruby",
            Language::Cobol => "COBOL",
            Language::Fortran => "Fortran",
            Language::Unknown => "Unknown",
        }
    }
}

// ─── Symbol ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Type,
    Enum,
    Variable,
    Constant,
    Component, // React/Vue component (function that returns JSX)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub start_line: usize,
    pub end_line: usize,
    pub params: Vec<String>,    // parameter names (for functions/methods)
    pub return_type: Option<String>,
    pub exported: bool,
}

// ─── Import / Export ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportInfo {
    pub source: String,         // e.g. "react", "./Button", "../utils/cn"
    pub names: Vec<String>,     // e.g. ["useState", "useEffect"]
    pub is_default: bool,       // import Button from "./Button"
    pub is_wildcard: bool,      // import * as React from "react"
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportInfo {
    pub name: String,
    pub is_default: bool,
    pub line: usize,
}

// ─── Call Sites (A1) ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSite {
    pub caller_function: String,
    pub caller_line: usize,
    pub callee_name: String,
    pub callee_args_count: usize,
}

// ─── Type References (A1) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TypeRefKind {
    Extends,
    Implements,
    Parameter,
    ReturnType,
    Variable,
    Field,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeReference {
    pub line: usize,
    pub name: String,
    pub kind: TypeRefKind,
}

// ─── Scope Info (A1) ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ScopeKind {
    Module,
    Function,
    Block,
    Class,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeInfo {
    pub start_line: usize,
    pub end_line: usize,
    pub kind: ScopeKind,
    pub name: Option<String>,
    pub variables: Vec<String>,
}

// ─── File Index ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndex {
    pub path: String,
    pub language: Language,
    pub size: u64,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<ImportInfo>,
    pub exports: Vec<ExportInfo>,
    pub call_sites: Vec<CallSite>,
    pub type_refs: Vec<TypeReference>,
    pub scopes: Vec<ScopeInfo>,
    pub line_count: usize,
}

// ─── Project Index ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectIndex {
    pub root: String,
    pub files: Vec<FileIndex>,
    pub framework: Option<String>,        // "React", "Next.js", "Express", etc.
    pub package_deps: Vec<String>,        // from package.json / Cargo.toml
    pub entry_points: Vec<String>,        // main files
    pub config_files: Vec<String>,        // tsconfig, vite.config, etc.
    pub dependency_graph: HashMap<String, Vec<String>>, // file → [files it imports]
}

impl ProjectIndex {
    pub fn new(root: String) -> Self {
        Self {
            root,
            files: Vec::new(),
            framework: None,
            package_deps: Vec::new(),
            entry_points: Vec::new(),
            config_files: Vec::new(),
            dependency_graph: HashMap::new(),
        }
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn symbol_count(&self) -> usize {
        self.files.iter().map(|f| f.symbols.len()).sum()
    }

    pub fn all_symbols(&self) -> Vec<(&str, &Symbol)> {
        self.files
            .iter()
            .flat_map(|f| f.symbols.iter().map(move |s| (f.path.as_str(), s)))
            .collect()
    }
}
