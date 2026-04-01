// ── Tree-sitter Parser ──────────────────────────────────────────────────────
// Parses source files with tree-sitter to extract symbols, imports, and exports.

use super::types::*;
use tree_sitter::{Parser, Node};
use regex::Regex;
use std::sync::LazyLock;

// ─── Compiled Regexes (compiled once, reused across all parse calls) ────────

// Move language regexes
static RE_MOVE_MODULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*module\s+[A-Za-z0-9_:]+::([A-Za-z_][A-Za-z0-9_]*)\s*\{"
).unwrap());
static RE_MOVE_FUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*(public(?:\(friend\))?(?:\s+entry)?\s+fun|entry\s+fun|fun)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?"
).unwrap());
static RE_MOVE_STRUCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*(?:public\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+has\s+[a-z, ]+)?\s*(?:\{|;)"
).unwrap());
static RE_MOVE_CONST: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*const\s+([A-Z_][A-Za-z0-9_]*)\s*:\s*([^=]+)="
).unwrap());
static RE_MOVE_USE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*use\s+([A-Za-z0-9_:]+(?:::\{[^}]+\}|::[A-Za-z_][A-Za-z0-9_]*))\s*;"
).unwrap());

// COBOL language regexes
static RE_COBOL_PROGRAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)PROGRAM-ID\.\s+([A-Z][A-Z0-9-]*)"
).unwrap());
static RE_COBOL_SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^[ \t]+([A-Z0-9][A-Z0-9-]+)\s+SECTION\."
).unwrap());
static RE_COBOL_PARA: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^[ \t]{4,11}([A-Z0-9][A-Z0-9-]{2,})\.\s*$"
).unwrap());
static RE_COBOL_01: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s+01\s+([A-Z][A-Z0-9-]+)"
).unwrap());
static RE_COBOL_PERFORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)PERFORM\s+([A-Z0-9][A-Z0-9-]+)"
).unwrap());
static RE_COBOL_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r#"(?m)CALL\s+['"]([A-Z][A-Z0-9-]*)['"]"#
).unwrap());
static RE_COBOL_COPY: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r#"(?m)COPY\s+['"]?([A-Z][A-Z0-9-]*)['"]?"#
).unwrap());

// Fortran language regexes
static RE_FORTRAN_PROGRAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*PROGRAM\s+([A-Z][A-Z0-9_]*)"
).unwrap());
static RE_FORTRAN_MODULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*MODULE\s+([A-Z][A-Z0-9_]*)"
).unwrap());
static RE_FORTRAN_SUB: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*(?:RECURSIVE\s+)?SUBROUTINE\s+([A-Z][A-Z0-9_]*)\s*(?:\(([^)]*)\))?"
).unwrap());
static RE_FORTRAN_FUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*(?:(?:PURE|ELEMENTAL|RECURSIVE)\s+)*(?:[A-Z]+\s+)?FUNCTION\s+([A-Z][A-Z0-9_]*)\s*(?:\(([^)]*)\))?"
).unwrap());
static RE_FORTRAN_USE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)^\s*USE\s+(?:::)?\s*([A-Z][A-Z0-9_]*)"
).unwrap());
static RE_FORTRAN_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?m)CALL\s+([A-Z][A-Z0-9_]*)\s*(?:\(|$)"
).unwrap());

/// Convert a byte offset to a 1-based line number.
fn byte_to_line(source: &str, byte: usize) -> usize {
    source[..byte.min(source.len())].bytes().filter(|&b| b == b'\n').count() + 1
}

/// Parse a source file and extract its index (symbols, imports, exports).
pub fn parse_file(content: &str, language: Language) -> FileIndex {
    let mut index = FileIndex {
        path: String::new(),
        language,
        size: content.len() as u64,
        symbols: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        call_sites: Vec::new(),
        type_refs: Vec::new(),
        scopes: Vec::new(),
        line_count: content.lines().count(),
    };

    // Solidity uses solang-parser (typed AST), not tree-sitter
    if matches!(language, Language::Solidity) {
        extract_solidity(content, &mut index);
        return index;
    }

    // Move uses a regex-based extractor (no tree-sitter grammar available on crates.io)
    if matches!(language, Language::Move) {
        extract_move(content, &mut index);
        return index;
    }

    // COBOL and Fortran use regex-based extractors
    if matches!(language, Language::Cobol) {
        extract_cobol(content, &mut index);
        return index;
    }
    if matches!(language, Language::Fortran) {
        extract_fortran(content, &mut index);
        return index;
    }

    let mut parser = Parser::new();

    let ts_language = match language {
        Language::TypeScript | Language::TypeScriptReact => {
            if matches!(language, Language::TypeScriptReact) {
                tree_sitter_typescript::LANGUAGE_TSX.into()
            } else {
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
            }
        }
        Language::JavaScript | Language::JavaScriptReact => {
            tree_sitter_javascript::LANGUAGE.into()
        }
        Language::Rust => tree_sitter_rust::LANGUAGE.into(),
        Language::Python => tree_sitter_python::LANGUAGE.into(),
        Language::Css => tree_sitter_css::LANGUAGE.into(),
        Language::Json => tree_sitter_json::LANGUAGE.into(),
        Language::Go => tree_sitter_go::LANGUAGE.into(),
        Language::C => tree_sitter_c::LANGUAGE.into(),
        Language::Cpp => tree_sitter_cpp::LANGUAGE.into(),
        Language::Java => tree_sitter_java::LANGUAGE.into(),
        Language::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        Language::Solidity | Language::Move | Language::Cobol | Language::Fortran | Language::Unknown => return index,
    };

    if parser.set_language(&ts_language).is_err() {
        return index;
    }

    let tree = match parser.parse(content, None) {
        Some(t) => t,
        None => return index,
    };

    let root = tree.root_node();

    match language {
        Language::TypeScript | Language::TypeScriptReact
        | Language::JavaScript | Language::JavaScriptReact => {
            extract_js_ts(&root, content, &mut index);
            extract_deep_js_ts(&root, content, &mut index);
        }
        Language::Rust => {
            extract_rust(&root, content, &mut index);
            extract_deep_rust(&root, content, &mut index);
        }
        Language::Python => {
            extract_python(&root, content, &mut index);
        }
        Language::Go => {
            extract_go(&root, content, &mut index);
            extract_calls_recursive(&root, content, "<module>", &mut index);
        }
        Language::C => {
            extract_c(&root, content, &mut index);
            extract_calls_recursive(&root, content, "<module>", &mut index);
        }
        Language::Cpp => {
            extract_cpp(&root, content, &mut index);
            extract_calls_recursive(&root, content, "<module>", &mut index);
        }
        Language::Java => {
            extract_java(&root, content, &mut index);
        }
        Language::Ruby => {
            extract_ruby(&root, content, &mut index);
        }
        _ => {} // CSS, JSON, Solidity (handled above) — no tree-sitter symbols
    }

    index
}

// ─── JavaScript / TypeScript Extraction ─────────────────────────────────────

fn extract_js_ts(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();

    for node in root.children(&mut cursor) {
        match node.kind() {
            // function declaration: function foo() {}
            "function_declaration" => {
                if let Some(sym) = extract_js_function(&node, source, false) {
                    index.symbols.push(sym);
                }
            }
            // export function foo() {}
            "export_statement" => {
                extract_js_export(&node, source, index);
            }
            // const foo = () => {}
            "lexical_declaration" | "variable_declaration" => {
                extract_js_variable(&node, source, index, false);
            }
            // import { x } from "y"
            "import_statement" => {
                if let Some(imp) = extract_js_import(&node, source) {
                    index.imports.push(imp);
                }
            }
            // interface Foo {}
            "interface_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Interface,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: false,
                    });
                }
            }
            // type Foo = {}
            "type_alias_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Type,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: false,
                    });
                }
            }
            // enum Foo {}
            "enum_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Enum,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: false,
                    });
                }
            }
            // class Foo {}
            "class_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: false,
                    });
                }
            }
            _ => {}
        }
    }
}

fn extract_js_function(node: &Node, source: &str, exported: bool) -> Option<Symbol> {
    let name = node.child_by_field_name("name")?;
    let name_text = node_text(&name, source).to_string();

    let params = node
        .child_by_field_name("parameters")
        .map(|p| extract_param_names(&p, source))
        .unwrap_or_default();

    let return_type = node
        .child_by_field_name("return_type")
        .map(|r| node_text(&r, source).trim_start_matches(':').trim().to_string());

    // Check if it returns JSX (React component)
    let body_text = node
        .child_by_field_name("body")
        .map(|b| node_text(&b, source))
        .unwrap_or("");
    let is_component = name_text.chars().next().map_or(false, |c| c.is_uppercase())
        && (body_text.contains("jsx(") || body_text.contains("<") || body_text.contains("React.createElement"));

    Some(Symbol {
        name: name_text,
        kind: if is_component { SymbolKind::Component } else { SymbolKind::Function },
        start_line: node.start_position().row + 1,
        end_line: node.end_position().row + 1,
        params,
        return_type,
        exported,
    })
}

fn extract_js_export(node: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = node.walk();
    let is_default = node_text(node, source).starts_with("export default");

    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_declaration" => {
                if let Some(mut sym) = extract_js_function(&child, source, true) {
                    sym.exported = true;
                    let name = sym.name.clone();
                    index.symbols.push(sym);
                    index.exports.push(ExportInfo {
                        name,
                        is_default,
                        line: node.start_position().row + 1,
                    });
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                extract_js_variable(&child, source, index, true);
            }
            "class_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(&name_node, source).to_string();
                    index.symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::Class,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: true,
                    });
                    index.exports.push(ExportInfo { name, is_default, line: node.start_position().row + 1 });
                }
            }
            "interface_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(&name_node, source).to_string();
                    index.symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::Interface,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: true,
                    });
                    index.exports.push(ExportInfo { name, is_default: false, line: node.start_position().row + 1 });
                }
            }
            "type_alias_declaration" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = node_text(&name_node, source).to_string();
                    index.symbols.push(Symbol {
                        name: name.clone(),
                        kind: SymbolKind::Type,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: true,
                    });
                    index.exports.push(ExportInfo { name, is_default: false, line: node.start_position().row + 1 });
                }
            }
            // export { Foo, Bar } or export { Foo } from "./module"
            "export_clause" => {
                let mut ec = child.walk();
                for spec in child.children(&mut ec) {
                    if spec.kind() == "export_specifier" {
                        if let Some(name_node) = spec.child_by_field_name("name") {
                            let name = node_text(&name_node, source).to_string();
                            index.exports.push(ExportInfo { name, is_default: false, line: node.start_position().row + 1 });
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn extract_js_variable(node: &Node, source: &str, index: &mut FileIndex, exported: bool) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declarator" {
            if let Some(name_node) = child.child_by_field_name("name") {
                let name = node_text(&name_node, source).to_string();
                let value = child.child_by_field_name("value");

                let kind = if let Some(val) = &value {
                    let val_kind = val.kind();
                    if val_kind == "arrow_function" || val_kind == "function" || val_kind == "function_expression" {
                        // Check if it's a component (uppercase + returns JSX)
                        let val_text = node_text(val, source);
                        if name.chars().next().map_or(false, |c| c.is_uppercase())
                            && (val_text.contains("jsx(") || val_text.contains("<") || val_text.contains("React.createElement"))
                        {
                            SymbolKind::Component
                        } else {
                            SymbolKind::Function
                        }
                    } else {
                        // Check if const (constant) vs let/var (variable)
                        if node_text(node, source).starts_with("const") {
                            SymbolKind::Constant
                        } else {
                            SymbolKind::Variable
                        }
                    }
                } else {
                    SymbolKind::Variable
                };

                let params = if matches!(kind, SymbolKind::Function | SymbolKind::Component) {
                    value
                        .and_then(|v| v.child_by_field_name("parameters"))
                        .map(|p| extract_param_names(&p, source))
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };

                index.symbols.push(Symbol {
                    name: name.clone(),
                    kind,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                    params,
                    return_type: None,
                    exported,
                });

                if exported {
                    index.exports.push(ExportInfo {
                        name,
                        is_default: false,
                        line: node.start_position().row + 1,
                    });
                }
            }
        }
    }
}

fn extract_js_import(node: &Node, source: &str) -> Option<ImportInfo> {
    let text = node_text(node, source);
    let line = node.start_position().row + 1;

    // Extract source string (the "from" path)
    let source_str = node.child_by_field_name("source")
        .map(|s| {
            let t = node_text(&s, source);
            t.trim_matches(|c| c == '\'' || c == '"').to_string()
        })
        .unwrap_or_default();

    if source_str.is_empty() {
        return None;
    }

    let mut names = Vec::new();
    let mut is_default = false;
    let mut is_wildcard = false;

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "import_clause" => {
                let mut ic = child.walk();
                for import_child in child.children(&mut ic) {
                    match import_child.kind() {
                        "identifier" => {
                            // default import
                            is_default = true;
                            names.push(node_text(&import_child, source).to_string());
                        }
                        "named_imports" => {
                            let mut ni = import_child.walk();
                            for spec in import_child.children(&mut ni) {
                                if spec.kind() == "import_specifier" {
                                    if let Some(name) = spec.child_by_field_name("name") {
                                        names.push(node_text(&name, source).to_string());
                                    }
                                }
                            }
                        }
                        "namespace_import" => {
                            is_wildcard = true;
                            if let Some(name) = import_child.child_by_field_name("name") {
                                names.push(node_text(&name, source).to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    // Fallback: parse from text if tree-sitter didn't give us enough
    if names.is_empty() && !source_str.is_empty() {
        if text.contains('*') {
            is_wildcard = true;
        }
    }

    Some(ImportInfo {
        source: source_str,
        names,
        is_default,
        is_wildcard,
        line,
    })
}

// ─── Rust Extraction ────────────────────────────────────────────────────────

fn extract_rust(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();

    for node in root.children(&mut cursor) {
        match node.kind() {
            "function_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let exported = node_text(&node, source).starts_with("pub ");
                    let params = node
                        .child_by_field_name("parameters")
                        .map(|p| extract_param_names(&p, source))
                        .unwrap_or_default();
                    let return_type = node
                        .child_by_field_name("return_type")
                        .map(|r| node_text(&r, source).trim_start_matches("->").trim().to_string());

                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Function,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params,
                        return_type,
                        exported,
                    });
                }
            }
            "struct_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let exported = node_text(&node, source).starts_with("pub ");
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Struct,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported,
                    });
                }
            }
            "enum_item" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let exported = node_text(&node, source).starts_with("pub ");
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Enum,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported,
                    });
                }
            }
            "impl_item" => {
                // Extract methods from impl blocks
                extract_rust_impl(&node, source, index);
            }
            "use_declaration" => {
                let text = node_text(&node, source);
                let line = node.start_position().row + 1;
                // Simple parse: use foo::bar::Baz;
                let source_path = text.trim_start_matches("use ").trim_end_matches(';').trim().to_string();
                let name = source_path.split("::").last().unwrap_or("").to_string();
                if !name.is_empty() && name != "*" {
                    index.imports.push(ImportInfo {
                        source: source_path,
                        names: vec![name],
                        is_default: false,
                        is_wildcard: text.contains("::*"),
                        line,
                    });
                }
            }
            _ => {}
        }
    }
}

fn extract_rust_impl(node: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "declaration_list" {
            let mut dc = child.walk();
            for item in child.children(&mut dc) {
                if item.kind() == "function_item" {
                    if let Some(name) = item.child_by_field_name("name") {
                        let exported = node_text(&item, source).starts_with("pub ");
                        let params = item
                            .child_by_field_name("parameters")
                            .map(|p| extract_param_names(&p, source))
                            .unwrap_or_default();

                        index.symbols.push(Symbol {
                            name: node_text(&name, source).to_string(),
                            kind: SymbolKind::Method,
                            start_line: item.start_position().row + 1,
                            end_line: item.end_position().row + 1,
                            params,
                            return_type: None,
                            exported,
                        });
                    }
                }
            }
        }
    }
}

// ─── Python Extraction ──────────────────────────────────────────────────────

fn extract_python(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();

    for node in root.children(&mut cursor) {
        match node.kind() {
            "function_definition" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let params = node
                        .child_by_field_name("parameters")
                        .map(|p| extract_param_names(&p, source))
                        .unwrap_or_default();

                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Function,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params,
                        return_type: None,
                        exported: true, // Python: everything at top level is "exported"
                    });
                }
            }
            "class_definition" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(),
                        return_type: None,
                        exported: true,
                    });
                }
            }
            "import_statement" | "import_from_statement" => {
                let text = node_text(&node, source).to_string();
                let line = node.start_position().row + 1;
                index.imports.push(ImportInfo {
                    source: text.clone(),
                    names: vec![],
                    is_default: false,
                    is_wildcard: text.contains("import *"),
                    line,
                });
            }
            _ => {}
        }
    }
}

// ─── Deep AST Extraction (A1) ───────────────────────────────────────────────
// Walks into function bodies to extract call sites, type references, and scopes.

fn extract_deep_js_ts(root: &Node, source: &str, index: &mut FileIndex) {
    extract_calls_recursive(root, source, "<module>", index);
    extract_type_refs_recursive(root, source, index);
    extract_scopes_recursive(root, source, index);
}

fn extract_deep_rust(root: &Node, source: &str, index: &mut FileIndex) {
    extract_calls_recursive(root, source, "<module>", index);
    extract_scopes_recursive(root, source, index);
}

/// Recursively walk the AST to find all call expressions.
fn extract_calls_recursive(node: &Node, source: &str, current_function: &str, index: &mut FileIndex) {
    let kind = node.kind();

    // Track which function we're inside
    let func_name = if kind == "function_declaration" || kind == "function_item"
        || kind == "method_definition" || kind == "arrow_function" {
        node.child_by_field_name("name")
            .map(|n| node_text(&n, source).to_string())
            .unwrap_or_else(|| current_function.to_string())
    } else {
        current_function.to_string()
    };

    // Detect call expressions
    if kind == "call_expression" {
        if let Some(callee) = node.child_by_field_name("function") {
            let callee_name = node_text(&callee, source);
            // Skip very common calls (console.log, etc.)
            if !callee_name.starts_with("console.") && !callee_name.is_empty() {
                let args = node.child_by_field_name("arguments");
                let arg_count = args.map(|a| {
                    let mut count = 0;
                    let mut cursor = a.walk();
                    for child in a.children(&mut cursor) {
                        if child.is_named() && child.kind() != "(" && child.kind() != ")" && child.kind() != "," {
                            count += 1;
                        }
                    }
                    count
                }).unwrap_or(0);

                index.call_sites.push(CallSite {
                    caller_function: func_name.clone(),
                    caller_line: node.start_position().row + 1,
                    callee_name: callee_name.to_string(),
                    callee_args_count: arg_count,
                });
            }
        }
    }

    // Rust: macro invocations (e.g., println!, vec!, format!)
    if kind == "macro_invocation" {
        if let Some(name_node) = node.child(0) {
            let name = node_text(&name_node, source);
            index.call_sites.push(CallSite {
                caller_function: func_name.clone(),
                caller_line: node.start_position().row + 1,
                callee_name: name.to_string(),
                callee_args_count: 0,
            });
        }
    }

    // Recurse into children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_calls_recursive(&child, source, &func_name, index);
    }
}

/// Extract type references — extends, implements, type annotations.
fn extract_type_refs_recursive(node: &Node, source: &str, index: &mut FileIndex) {
    let kind = node.kind();

    // extends clause: class Foo extends Bar
    if kind == "extends_clause" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.is_named() && child.kind() != "extends" {
                index.type_refs.push(TypeReference {
                    line: child.start_position().row + 1,
                    name: node_text(&child, source).to_string(),
                    kind: TypeRefKind::Extends,
                });
            }
        }
    }

    // implements clause: class Foo implements Bar, Baz
    if kind == "implements_clause" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.is_named() {
                index.type_refs.push(TypeReference {
                    line: child.start_position().row + 1,
                    name: node_text(&child, source).to_string(),
                    kind: TypeRefKind::Implements,
                });
            }
        }
    }

    // Type annotations: param: Type, : ReturnType, let x: Type
    if kind == "type_annotation" {
        if let Some(type_node) = node.child(1).or(node.child_by_field_name("type")) {
            let type_name = node_text(&type_node, source).to_string();
            // Determine context from parent
            let parent_kind = node.parent().map(|p| p.kind()).unwrap_or("");
            let ref_kind = match parent_kind {
                "required_parameter" | "optional_parameter" | "formal_parameters" => TypeRefKind::Parameter,
                "function_declaration" | "arrow_function" | "method_definition" => TypeRefKind::ReturnType,
                "variable_declarator" | "lexical_declaration" => TypeRefKind::Variable,
                "property_signature" | "public_field_definition" => TypeRefKind::Field,
                _ => TypeRefKind::Variable,
            };
            if !type_name.is_empty() && type_name != "string" && type_name != "number"
                && type_name != "boolean" && type_name != "void" && type_name != "any"
                && type_name != "null" && type_name != "undefined" {
                index.type_refs.push(TypeReference {
                    line: type_node.start_position().row + 1,
                    name: type_name,
                    kind: ref_kind,
                });
            }
        }
    }

    // Recurse
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_type_refs_recursive(&child, source, index);
    }
}

/// Extract scope information — function scopes, block scopes, class scopes.
fn extract_scopes_recursive(node: &Node, source: &str, index: &mut FileIndex) {
    let kind = node.kind();

    let scope = match kind {
        "function_declaration" | "function_item" | "arrow_function" | "method_definition" => {
            let name = node.child_by_field_name("name")
                .map(|n| node_text(&n, source).to_string());
            let vars = extract_scope_variables(node, source);
            Some(ScopeInfo {
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
                kind: ScopeKind::Function,
                name,
                variables: vars,
            })
        }
        "class_declaration" | "class_body" | "impl_item" => {
            let name = node.child_by_field_name("name")
                .map(|n| node_text(&n, source).to_string());
            Some(ScopeInfo {
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
                kind: ScopeKind::Class,
                name,
                variables: Vec::new(),
            })
        }
        "block" | "statement_block" if node.parent().map(|p| p.kind()) != Some("function_declaration") => {
            let vars = extract_scope_variables(node, source);
            if !vars.is_empty() {
                Some(ScopeInfo {
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                    kind: ScopeKind::Block,
                    name: None,
                    variables: vars,
                })
            } else {
                None
            }
        }
        _ => None,
    };

    if let Some(s) = scope {
        index.scopes.push(s);
    }

    // Recurse
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_scopes_recursive(&child, source, index);
    }
}

/// Extract variable declarations within a scope node.
fn extract_scope_variables(node: &Node, source: &str) -> Vec<String> {
    let mut vars = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        if kind == "lexical_declaration" || kind == "variable_declaration" || kind == "let_declaration" {
            let mut inner = child.walk();
            for decl in child.children(&mut inner) {
                if decl.kind() == "variable_declarator" {
                    if let Some(name) = decl.child_by_field_name("name") {
                        vars.push(node_text(&name, source).to_string());
                    }
                }
            }
        }
        // Function parameters
        if kind == "formal_parameters" || kind == "parameters" {
            let mut inner = child.walk();
            for param in child.children(&mut inner) {
                if let Some(name) = param.child_by_field_name("pattern").or(param.child_by_field_name("name")) {
                    let n = node_text(&name, source);
                    if n != "self" && n != "&self" {
                        vars.push(n.to_string());
                    }
                }
            }
        }
    }
    vars
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn node_text<'a>(node: &Node, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}

// ─── Solidity Extraction (solang-parser) ─────────────────────────────────────

fn extract_solidity(source: &str, index: &mut FileIndex) {
    let (tree, _) = match solang_parser::parse(source, 0) {
        Ok(result) => result,
        Err(_) => return,
    };

    for part in &tree.0 {
        match part {
            solang_parser::pt::SourceUnitPart::ContractDefinition(c) => {
                let name = match &c.name {
                    Some(id) => id.name.clone(),
                    None => continue,
                };
                let kind = match &c.ty {
                    solang_parser::pt::ContractTy::Interface(_) => SymbolKind::Interface,
                    _ => SymbolKind::Class,
                };
                let (start, end) = loc_lines(&c.loc, source);
                index.symbols.push(Symbol {
                    name: name.clone(),
                    kind,
                    start_line: start,
                    end_line: end,
                    params: Vec::new(),
                    return_type: None,
                    exported: true,
                });
                for cpart in &c.parts {
                    extract_solidity_contract_part(cpart, source, index);
                }
            }
            solang_parser::pt::SourceUnitPart::FunctionDefinition(f) => {
                extract_solidity_function(f, source, index);
            }
            solang_parser::pt::SourceUnitPart::StructDefinition(s) => {
                if let Some(id) = &s.name {
                    let (start, end) = loc_lines(&s.loc, source);
                    index.symbols.push(Symbol {
                        name: id.name.clone(), kind: SymbolKind::Struct,
                        start_line: start, end_line: end,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            solang_parser::pt::SourceUnitPart::EnumDefinition(e) => {
                if let Some(id) = &e.name {
                    let (start, end) = loc_lines(&e.loc, source);
                    index.symbols.push(Symbol {
                        name: id.name.clone(), kind: SymbolKind::Enum,
                        start_line: start, end_line: end,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            solang_parser::pt::SourceUnitPart::EventDefinition(e) => {
                if let Some(id) = &e.name {
                    let (start, end) = loc_lines(&e.loc, source);
                    index.symbols.push(Symbol {
                        name: id.name.clone(), kind: SymbolKind::Type,
                        start_line: start, end_line: end,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            solang_parser::pt::SourceUnitPart::ErrorDefinition(e) => {
                if let Some(id) = &e.name {
                    let (start, end) = loc_lines(&e.loc, source);
                    index.symbols.push(Symbol {
                        name: id.name.clone(), kind: SymbolKind::Type,
                        start_line: start, end_line: end,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            solang_parser::pt::SourceUnitPart::ImportDirective(_) => {
                // Import path extraction skipped — ImportPath API varies by solang-parser version.
                // Symbol extraction (contracts, functions, events, structs) is unaffected.
            }
            _ => {}
        }
    }
}

fn extract_solidity_contract_part(
    part: &solang_parser::pt::ContractPart,
    source: &str,
    index: &mut FileIndex,
) {
    match part {
        solang_parser::pt::ContractPart::FunctionDefinition(f) => {
            extract_solidity_function(f, source, index);
        }
        solang_parser::pt::ContractPart::StructDefinition(s) => {
            if let Some(id) = &s.name {
                let (start, end) = loc_lines(&s.loc, source);
                index.symbols.push(Symbol {
                    name: id.name.clone(), kind: SymbolKind::Struct,
                    start_line: start, end_line: end,
                    params: Vec::new(), return_type: None, exported: false,
                });
            }
        }
        solang_parser::pt::ContractPart::EnumDefinition(e) => {
            if let Some(id) = &e.name {
                let (start, end) = loc_lines(&e.loc, source);
                index.symbols.push(Symbol {
                    name: id.name.clone(), kind: SymbolKind::Enum,
                    start_line: start, end_line: end,
                    params: Vec::new(), return_type: None, exported: false,
                });
            }
        }
        solang_parser::pt::ContractPart::EventDefinition(e) => {
            if let Some(id) = &e.name {
                let (start, end) = loc_lines(&e.loc, source);
                index.symbols.push(Symbol {
                    name: id.name.clone(), kind: SymbolKind::Type,
                    start_line: start, end_line: end,
                    params: Vec::new(), return_type: None, exported: false,
                });
            }
        }
        solang_parser::pt::ContractPart::ErrorDefinition(e) => {
            if let Some(id) = &e.name {
                let (start, end) = loc_lines(&e.loc, source);
                index.symbols.push(Symbol {
                    name: id.name.clone(), kind: SymbolKind::Type,
                    start_line: start, end_line: end,
                    params: Vec::new(), return_type: None, exported: false,
                });
            }
        }
        _ => {}
    }
}

fn extract_solidity_function(
    f: &solang_parser::pt::FunctionDefinition,
    source: &str,
    index: &mut FileIndex,
) {
    let name = match &f.name {
        Some(id) => id.name.clone(),
        None => match &f.ty {
            solang_parser::pt::FunctionTy::Constructor => "constructor".to_string(),
            solang_parser::pt::FunctionTy::Fallback => "fallback".to_string(),
            solang_parser::pt::FunctionTy::Receive => "receive".to_string(),
            _ => return,
        },
    };
    let params: Vec<String> = f.params.iter()
        .filter_map(|(_, p)| p.as_ref()?.name.as_ref().map(|n| n.name.clone()))
        .collect();
    let (start, end) = loc_lines(&f.loc, source);
    index.symbols.push(Symbol {
        name,
        kind: SymbolKind::Function,
        start_line: start,
        end_line: end,
        params,
        return_type: None,
        exported: true,
    });
}

fn loc_lines(loc: &solang_parser::pt::Loc, source: &str) -> (usize, usize) {
    match loc {
        solang_parser::pt::Loc::File(_, start, end) => {
            (byte_to_line(source, *start), byte_to_line(source, *end))
        }
        _ => (1, 1),
    }
}

// ─── Go Extraction ───────────────────────────────────────────────────────────

fn extract_go(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();
    for node in root.children(&mut cursor) {
        match node.kind() {
            "function_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let name_text = node_text(&name, source).to_string();
                    let exported = name_text.chars().next().map_or(false, |c| c.is_uppercase());
                    let params = node.child_by_field_name("parameters")
                        .map(|p| extract_go_params(&p, source))
                        .unwrap_or_default();
                    let return_type = node.child_by_field_name("result")
                        .map(|r| node_text(&r, source).to_string());
                    index.symbols.push(Symbol {
                        name: name_text, kind: SymbolKind::Function,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params, return_type, exported,
                    });
                }
            }
            "method_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let name_text = node_text(&name, source).to_string();
                    let exported = name_text.chars().next().map_or(false, |c| c.is_uppercase());
                    let params = node.child_by_field_name("parameters")
                        .map(|p| extract_go_params(&p, source))
                        .unwrap_or_default();
                    index.symbols.push(Symbol {
                        name: name_text, kind: SymbolKind::Method,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params, return_type: None, exported,
                    });
                }
            }
            "type_declaration" => {
                extract_go_type_decl(&node, source, index);
            }
            "const_declaration" => {
                extract_go_specs(&node, source, index, SymbolKind::Constant);
            }
            "var_declaration" => {
                extract_go_specs(&node, source, index, SymbolKind::Variable);
            }
            "import_declaration" => {
                extract_go_imports(&node, source, index);
            }
            _ => {}
        }
    }
}

fn extract_go_params(params_node: &Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        if child.kind() == "parameter_declaration" || child.kind() == "variadic_parameter_declaration" {
            // Collect identifier children (the parameter names)
            let mut inner = child.walk();
            for param in child.children(&mut inner) {
                if param.kind() == "identifier" {
                    names.push(node_text(&param, source).to_string());
                }
            }
        }
    }
    names
}

fn extract_go_type_decl(node: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "type_spec" {
            if let Some(name) = child.child_by_field_name("name") {
                let name_text = node_text(&name, source).to_string();
                let type_node = child.child_by_field_name("type");
                let kind = match type_node.map(|t| t.kind()) {
                    Some("struct_type") => SymbolKind::Struct,
                    Some("interface_type") => SymbolKind::Interface,
                    _ => SymbolKind::Type,
                };
                let exported = name_text.chars().next().map_or(false, |c| c.is_uppercase());
                index.symbols.push(Symbol {
                    name: name_text, kind,
                    start_line: child.start_position().row + 1,
                    end_line: child.end_position().row + 1,
                    params: Vec::new(), return_type: None, exported,
                });
            }
        }
    }
}

fn extract_go_specs(node: &Node, source: &str, index: &mut FileIndex, kind: SymbolKind) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let spec_kind = child.kind();
        if spec_kind == "const_spec" || spec_kind == "var_spec" {
            if let Some(name) = child.child_by_field_name("name") {
                let name_text = node_text(&name, source).to_string();
                let exported = name_text.chars().next().map_or(false, |c| c.is_uppercase());
                index.symbols.push(Symbol {
                    name: name_text, kind: kind.clone(),
                    start_line: child.start_position().row + 1,
                    end_line: child.end_position().row + 1,
                    params: Vec::new(), return_type: None, exported,
                });
            }
        }
    }
}

fn extract_go_imports(node: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "import_spec" || child.kind() == "import_spec_list" {
            if child.kind() == "import_spec_list" {
                let mut inner = child.walk();
                for spec in child.children(&mut inner) {
                    if spec.kind() == "import_spec" {
                        push_go_import(&spec, source, index);
                    }
                }
            } else {
                push_go_import(&child, source, index);
            }
        }
    }
}

fn push_go_import(spec: &Node, source: &str, index: &mut FileIndex) {
    if let Some(path) = spec.child_by_field_name("path") {
        let raw = node_text(&path, source);
        let path_str = raw.trim_matches(|c| c == '"' || c == '`').to_string();
        let name = path_str.split('/').last().unwrap_or(&path_str).to_string();
        index.imports.push(ImportInfo {
            source: path_str, names: vec![name],
            is_default: false, is_wildcard: false,
            line: spec.start_position().row + 1,
        });
    }
}

// ─── C Extraction ────────────────────────────────────────────────────────────

fn extract_c(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();
    for node in root.children(&mut cursor) {
        match node.kind() {
            "function_definition" => {
                if let Some(name) = find_c_function_name(&node, source) {
                    let params = find_c_params(&node, source);
                    index.symbols.push(Symbol {
                        name, kind: SymbolKind::Function,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params, return_type: None, exported: true,
                    });
                }
            }
            "struct_specifier" | "union_specifier" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Struct,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "enum_specifier" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Enum,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "type_definition" => {
                // typedef struct Foo { ... } FooType; — name is last identifier before ;
                if let Some(name) = find_typedef_name(&node, source) {
                    index.symbols.push(Symbol {
                        name, kind: SymbolKind::Type,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "preproc_include" => {
                // #include "foo.h" or #include <foo.h>
                let text = node_text(&node, source);
                let path = text.trim_start_matches("#include").trim()
                    .trim_matches(|c| c == '"' || c == '<' || c == '>').to_string();
                if !path.is_empty() {
                    index.imports.push(ImportInfo {
                        source: path, names: Vec::new(),
                        is_default: false, is_wildcard: false,
                        line: node.start_position().row + 1,
                    });
                }
            }
            _ => {}
        }
    }
}

/// Walk the declarator tree to find the innermost function name identifier.
fn find_c_function_name(func_def: &Node, source: &str) -> Option<String> {
    let declarator = func_def.child_by_field_name("declarator")?;
    find_declarator_name(&declarator, source)
}

fn find_declarator_name(node: &Node, source: &str) -> Option<String> {
    match node.kind() {
        "identifier" | "field_identifier" => Some(node_text(node, source).to_string()),
        "function_declarator" => {
            node.child_by_field_name("declarator")
                .and_then(|d| find_declarator_name(&d, source))
        }
        "pointer_declarator" | "abstract_pointer_declarator" => {
            node.child_by_field_name("declarator")
                .and_then(|d| find_declarator_name(&d, source))
        }
        _ => {
            // Try any named child
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if let Some(name) = find_declarator_name(&child, source) {
                    return Some(name);
                }
            }
            None
        }
    }
}

fn find_c_params(func_def: &Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(decl) = func_def.child_by_field_name("declarator") {
        collect_c_params_from_declarator(&decl, source, &mut names);
    }
    names
}

/// Recursively walk the declarator tree to find function_declarator parameters.
fn collect_c_params_from_declarator(node: &Node, source: &str, names: &mut Vec<String>) {
    if node.kind() == "function_declarator" {
        if let Some(params) = node.child_by_field_name("parameters") {
            let mut cursor = params.walk();
            for child in params.children(&mut cursor) {
                if child.kind() == "parameter_declaration" {
                    if let Some(name) = find_param_name_in_declaration(&child, source) {
                        names.push(name);
                    }
                }
            }
        }
        return; // found it, stop recursing
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_c_params_from_declarator(&child, source, names);
    }
}

fn find_param_name_in_declaration(node: &Node, source: &str) -> Option<String> {
    // Walk children and return the last identifier (the param name)
    let mut last_ident = None;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "identifier" {
            last_ident = Some(node_text(&child, source).to_string());
        }
    }
    last_ident
}

fn find_typedef_name(node: &Node, source: &str) -> Option<String> {
    // In a type_definition, the declarator field holds the new type name
    node.child_by_field_name("declarator")
        .and_then(|d| find_declarator_name(&d, source))
}

// ─── C++ Extraction ──────────────────────────────────────────────────────────

fn extract_cpp(root: &Node, source: &str, index: &mut FileIndex) {
    // Reuse C extraction for shared constructs
    extract_c(root, source, index);

    // Add C++-specific top-level constructs
    let mut cursor = root.walk();
    for node in root.children(&mut cursor) {
        match node.kind() {
            "class_specifier" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let name_text = node_text(&name, source).to_string();
                    index.symbols.push(Symbol {
                        name: name_text, kind: SymbolKind::Class,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                    // Extract methods from class body
                    extract_cpp_class_body(&node, source, index);
                }
            }
            "namespace_definition" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "template_declaration" => {
                // template<...> class/function — recurse into child
                let mut tc = node.walk();
                for child in node.children(&mut tc) {
                    match child.kind() {
                        "class_specifier" => {
                            if let Some(name) = child.child_by_field_name("name") {
                                index.symbols.push(Symbol {
                                    name: node_text(&name, source).to_string(),
                                    kind: SymbolKind::Class,
                                    start_line: child.start_position().row + 1,
                                    end_line: child.end_position().row + 1,
                                    params: Vec::new(), return_type: None, exported: true,
                                });
                            }
                        }
                        "function_definition" => {
                            if let Some(name) = find_c_function_name(&child, source) {
                                index.symbols.push(Symbol {
                                    name, kind: SymbolKind::Function,
                                    start_line: child.start_position().row + 1,
                                    end_line: child.end_position().row + 1,
                                    params: Vec::new(), return_type: None, exported: true,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

fn extract_cpp_class_body(class_node: &Node, source: &str, index: &mut FileIndex) {
    if let Some(body) = class_node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            if child.kind() == "function_definition" {
                if let Some(name) = find_c_function_name(&child, source) {
                    index.symbols.push(Symbol {
                        name, kind: SymbolKind::Method,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: false,
                    });
                }
            }
        }
    }
}

// ─── Java Extraction ─────────────────────────────────────────────────────────

fn extract_java(root: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = root.walk();
    for node in root.children(&mut cursor) {
        match node.kind() {
            "class_declaration" | "record_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let exported = node_text(&node, source).contains("public ");
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Class,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported,
                    });
                    extract_java_class_body(&node, source, index);
                }
            }
            "interface_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Interface,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "enum_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Enum,
                        start_line: node.start_position().row + 1,
                        end_line: node.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            "import_declaration" => {
                let text = node_text(&node, source);
                let path = text.trim_start_matches("import").trim().trim_end_matches(';').trim().to_string();
                let name = path.split('.').last().unwrap_or(&path).to_string();
                let is_wildcard = name == "*";
                index.imports.push(ImportInfo {
                    source: path, names: if is_wildcard { Vec::new() } else { vec![name] },
                    is_default: false, is_wildcard,
                    line: node.start_position().row + 1,
                });
            }
            _ => {}
        }
    }
}

fn extract_java_class_body(class_node: &Node, source: &str, index: &mut FileIndex) {
    if let Some(body) = class_node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            match child.kind() {
                "method_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        let exported = node_text(&child, source).contains("public ");
                        let params = child.child_by_field_name("parameters")
                            .map(|p| extract_java_params(&p, source))
                            .unwrap_or_default();
                        let return_type = child.child_by_field_name("type")
                            .map(|t| node_text(&t, source).to_string());
                        index.symbols.push(Symbol {
                            name: node_text(&name, source).to_string(),
                            kind: SymbolKind::Method,
                            start_line: child.start_position().row + 1,
                            end_line: child.end_position().row + 1,
                            params, return_type, exported,
                        });
                    }
                }
                "constructor_declaration" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        let params = child.child_by_field_name("parameters")
                            .map(|p| extract_java_params(&p, source))
                            .unwrap_or_default();
                        index.symbols.push(Symbol {
                            name: node_text(&name, source).to_string(),
                            kind: SymbolKind::Method,
                            start_line: child.start_position().row + 1,
                            end_line: child.end_position().row + 1,
                            params, return_type: None, exported: false,
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

fn extract_java_params(params_node: &Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        if child.kind() == "formal_parameter" || child.kind() == "spread_parameter" {
            if let Some(name) = child.child_by_field_name("name") {
                names.push(node_text(&name, source).to_string());
            }
        }
    }
    names
}

// ─── Ruby Extraction ─────────────────────────────────────────────────────────

fn extract_ruby(root: &Node, source: &str, index: &mut FileIndex) {
    extract_ruby_body(root, source, index);
}

fn extract_ruby_body(node: &Node, source: &str, index: &mut FileIndex) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "class" => {
                // Ruby class node: name is a "constant" or "scope_resolution" child
                if let Some(name) = find_ruby_class_name(&child, source) {
                    index.symbols.push(Symbol {
                        name, kind: SymbolKind::Class,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
                extract_ruby_body(&child, source, index);
            }
            "module" => {
                if let Some(name) = find_ruby_class_name(&child, source) {
                    index.symbols.push(Symbol {
                        name, kind: SymbolKind::Class,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
                extract_ruby_body(&child, source, index);
            }
            "method" => {
                if let Some(name) = child.child_by_field_name("name") {
                    let params = child.child_by_field_name("parameters")
                        .map(|p| extract_ruby_params(&p, source))
                        .unwrap_or_default();
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Method,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params, return_type: None, exported: true,
                    });
                }
            }
            "singleton_method" => {
                // def self.foo — name field
                if let Some(name) = child.child_by_field_name("name") {
                    index.symbols.push(Symbol {
                        name: node_text(&name, source).to_string(),
                        kind: SymbolKind::Method,
                        start_line: child.start_position().row + 1,
                        end_line: child.end_position().row + 1,
                        params: Vec::new(), return_type: None, exported: true,
                    });
                }
            }
            _ => {}
        }
    }
}

fn find_ruby_class_name(node: &Node, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "constant" => return Some(node_text(&child, source).to_string()),
            "scope_resolution" => {
                // Module::ClassName — take the last constant
                let mut sc = child.walk();
                let mut last = None;
                for n in child.children(&mut sc) {
                    if n.kind() == "constant" {
                        last = Some(node_text(&n, source).to_string());
                    }
                }
                return last;
            }
            _ => {}
        }
    }
    None
}

fn extract_ruby_params(params_node: &Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        match child.kind() {
            "identifier" => names.push(node_text(&child, source).to_string()),
            "optional_parameter" | "splat_parameter" | "block_parameter" | "keyword_parameter" => {
                if let Some(name) = child.child_by_field_name("name") {
                    names.push(node_text(&name, source).to_string());
                }
            }
            _ => {}
        }
    }
    names
}

fn extract_param_names(params_node: &Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => {
                let name = node_text(&child, source).to_string();
                if name != "self" && name != "&self" && name != "&mut self" {
                    names.push(name);
                }
            }
            "required_parameter" | "optional_parameter" | "parameter" => {
                if let Some(pattern) = child.child_by_field_name("pattern") {
                    names.push(node_text(&pattern, source).to_string());
                } else if let Some(name) = child.child_by_field_name("name") {
                    names.push(node_text(&name, source).to_string());
                }
            }
            _ => {}
        }
    }
    names
}

// ─── Move Extraction ─────────────────────────────────────────────────────────
// Regex-based extractor for Aptos/Sui Move (.move files).
// Covers: modules, functions (public/entry/friend), structs, constants, use imports.

fn extract_move(source: &str, index: &mut FileIndex) {
    let lines: Vec<&str> = source.lines().collect();

    let re_module = &*RE_MOVE_MODULE;
    let re_fun = &*RE_MOVE_FUN;
    let re_struct = &*RE_MOVE_STRUCT;
    let re_const = &*RE_MOVE_CONST;
    let re_use = &*RE_MOVE_USE;

    // ── Modules ───────────────────────────────────────────────────────────────
    for cap in re_module.captures_iter(source) {
        let name = cap[1].to_string();
        let line = byte_to_line(source, cap.get(0).unwrap().start());
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Class, // closest analogue — Move module = namespace/contract
            start_line: line,
            end_line: line,
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    for cap in re_fun.captures_iter(source) {
        let vis = cap[1].to_string();
        let name = cap[2].to_string();
        let params_raw = cap.get(3).map_or("", |m| m.as_str());
        let return_type = cap.get(4).map(|m| m.as_str().trim().to_string());
        let exported = vis.contains("public") || vis.contains("entry");

        let params: Vec<String> = params_raw
            .split(',')
            .filter_map(|p| {
                let p = p.trim();
                if p.is_empty() { return None; }
                // param format: `name: Type` or `&signer` or `ctx: &mut TxContext`
                let name_part = p.split(':').next().unwrap_or(p).trim();
                let clean = name_part.trim_start_matches('&').trim_start_matches("mut ").trim();
                if clean.is_empty() || clean == "signer" { return None; }
                Some(clean.to_string())
            })
            .collect();

        let line = byte_to_line(source, cap.get(0).unwrap().start());
        let end_line = find_block_end(&lines, line.saturating_sub(1));

        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Function,
            start_line: line,
            end_line,
            params,
            return_type,
            exported,
        });
    }

    // ── Structs ───────────────────────────────────────────────────────────────
    for cap in re_struct.captures_iter(source) {
        let name = cap[1].to_string();
        let line = byte_to_line(source, cap.get(0).unwrap().start());
        let end_line = find_block_end(&lines, line.saturating_sub(1));
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Struct,
            start_line: line,
            end_line,
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── Constants ─────────────────────────────────────────────────────────────
    for cap in re_const.captures_iter(source) {
        let name = cap[1].to_string();
        let ty = cap[2].trim().to_string();
        let line = byte_to_line(source, cap.get(0).unwrap().start());
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Constant,
            start_line: line,
            end_line: line,
            params: Vec::new(),
            return_type: Some(ty),
            exported: false,
        });
    }

    // ── Imports (use statements) ───────────────────────────────────────────────
    for cap in re_use.captures_iter(source) {
        let full_path = cap[1].to_string();
        let line = byte_to_line(source, cap.get(0).unwrap().start());

        let names: Vec<String> = if let Some(brace_start) = full_path.find('{') {
            let inner = &full_path[brace_start + 1..full_path.rfind('}').unwrap_or(full_path.len())];
            inner.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        } else {
            full_path.split("::").last()
                .map(|s| vec![s.to_string()])
                .unwrap_or_default()
        };

        let module_path = if let Some(pos) = full_path.rfind("::") {
            full_path[..pos].to_string()
        } else {
            full_path.clone()
        };

        index.imports.push(ImportInfo {
            source: module_path,
            names,
            is_default: false,
            is_wildcard: false,
            line,
        });
    }
}

/// Walk forward from `start_line` (0-indexed) counting braces to find the
/// line where the opening `{` block closes. Returns 1-indexed end line.
fn find_block_end(lines: &[&str], start_line: usize) -> usize {
    let mut depth: i32 = 0;
    let mut found_open = false;

    for (i, line) in lines.iter().enumerate().skip(start_line) {
        for ch in line.chars() {
            match ch {
                '{' => { depth += 1; found_open = true; }
                '}' => {
                    depth -= 1;
                    if found_open && depth <= 0 {
                        return i + 1; // 1-indexed
                    }
                }
                _ => {}
            }
        }
    }
    start_line + 1
}

// ─── COBOL Extraction ────────────────────────────────────────────────────────
// Regex-based extractor for COBOL (.cbl, .cob, .cobol, .cpy files).
// Covers: programs, divisions, sections, paragraphs, PERFORM calls, CALL statements,
// COPY statements (copybook imports), and top-level 01-level data items.
//
// COBOL concepts → OPIDE index concepts:
//   PROGRAM-ID          → SymbolKind::Class   (top-level container)
//   PROCEDURE DIVISION section → SymbolKind::Class
//   Paragraph           → SymbolKind::Function (callable unit)
//   PERFORM para-name   → CallSite
//   CALL 'PROG-NAME'    → CallSite (external program call)
//   COPY copybook       → ImportInfo
//   01 level data item  → SymbolKind::Struct  (top-level record)

fn extract_cobol(source: &str, index: &mut FileIndex) {
    // Normalise to uppercase for case-insensitive matching — COBOL is traditionally
    // uppercase but modern compilers accept mixed case.
    let upper = source.to_uppercase();
    let lines: Vec<&str> = source.lines().collect();

    // ── PROGRAM-ID ────────────────────────────────────────────────────────────
    // PROGRAM-ID. PROG-NAME.   or   PROGRAM-ID. PROG-NAME
    let re_program = &*RE_COBOL_PROGRAM;
    for cap in re_program.captures_iter(&upper) {
        let name = cap[1].to_string();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.symbols.push(Symbol {
            name: name.clone(),
            kind: SymbolKind::Class,
            start_line: line,
            end_line: lines.len(),
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── PROCEDURE DIVISION sections ───────────────────────────────────────────
    // SECTION-NAME SECTION.
    let re_section = &*RE_COBOL_SECTION;
    let section_starts: Vec<(String, usize)> = re_section
        .captures_iter(&upper)
        .map(|cap| {
            let name = cap[1].to_string();
            let line = byte_to_line(&upper, cap.get(0).unwrap().start());
            (name, line)
        })
        .collect();

    for (i, (name, start_line)) in section_starts.iter().enumerate() {
        // Skip IDENTIFICATION, DATA, ENVIRONMENT, PROCEDURE divisions masquerading as sections
        if matches!(name.as_str(), "IDENTIFICATION" | "DATA" | "ENVIRONMENT" | "PROCEDURE" | "CONFIGURATION" | "INPUT-OUTPUT" | "FILE" | "WORKING-STORAGE" | "LOCAL-STORAGE" | "LINKAGE" | "SCREEN" | "REPORT") {
            continue;
        }
        let end_line = section_starts
            .get(i + 1)
            .map(|(_, l)| l.saturating_sub(1))
            .unwrap_or(lines.len());
        index.symbols.push(Symbol {
            name: name.clone(),
            kind: SymbolKind::Class,
            start_line: *start_line,
            end_line,
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── Paragraphs ────────────────────────────────────────────────────────────
    // In COBOL, a paragraph is a name in Area A (columns 8-11) followed by a period.
    // Pattern: line starts with optional whitespace (≥ 6 chars indent for Area A),
    // then an identifier, then a period, with nothing else on the line (or just spaces).
    // We skip section headers (already captured above) and division headers.
    let re_para = &*RE_COBOL_PARA;

    let skip_names: std::collections::HashSet<&str> = [
        "IDENTIFICATION", "DATA", "ENVIRONMENT", "PROCEDURE", "CONFIGURATION",
        "INPUT-OUTPUT", "FILE", "WORKING-STORAGE", "LOCAL-STORAGE", "LINKAGE",
        "SCREEN", "REPORT", "DIVISION", "SECTION", "END", "STOP",
    ].iter().cloned().collect();

    let para_starts: Vec<(String, usize)> = re_para
        .captures_iter(&upper)
        .filter_map(|cap| {
            let name = cap[1].to_string();
            if skip_names.contains(name.as_str()) { return None; }
            // Skip if name looks like a data level number or division keyword combo
            if name.ends_with("-DIVISION") || name.ends_with("-SECTION") { return None; }
            let line = byte_to_line(&upper, cap.get(0).unwrap().start());
            Some((name, line))
        })
        .collect();

    for (i, (name, start_line)) in para_starts.iter().enumerate() {
        let end_line = para_starts
            .get(i + 1)
            .map(|(_, l)| l.saturating_sub(1))
            .unwrap_or(lines.len());
        index.symbols.push(Symbol {
            name: name.clone(),
            kind: SymbolKind::Function,
            start_line: *start_line,
            end_line,
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── 01-level data items (top-level records) ───────────────────────────────
    // 01 RECORD-NAME.   or   01 WS-COUNTER PIC 9(4).
    let re_01 = &*RE_COBOL_01;
    for cap in re_01.captures_iter(&upper) {
        let name = cap[1].to_string();
        if name == "FILLER" { continue; }
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Struct,
            start_line: line,
            end_line: line,
            params: Vec::new(),
            return_type: None,
            exported: false,
        });
    }

    // ── PERFORM calls → CallSite ──────────────────────────────────────────────
    // PERFORM PARA-NAME
    // PERFORM PARA-NAME UNTIL / THRU / VARYING
    // PERFORM PARA-NAME THRU END-PARA
    let re_perform = &*RE_COBOL_PERFORM;
    for cap in re_perform.captures_iter(&upper) {
        let callee = cap[1].to_string();
        // Skip PERFORM VARYING / PERFORM UNTIL inline (no target name)
        if matches!(callee.as_str(), "VARYING" | "UNTIL" | "WITH" | "TEST" | "THROUGH" | "THRU") {
            continue;
        }
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        // Find which paragraph this PERFORM is in
        let caller = para_starts
            .iter()
            .rev()
            .find(|(_, start)| *start <= line)
            .map(|(n, _)| n.clone())
            .unwrap_or_else(|| "<program>".to_string());
        index.call_sites.push(CallSite {
            caller_function: caller,
            caller_line: line,
            callee_name: callee,
            callee_args_count: 0,
        });
    }

    // ── CALL statements → CallSite (external program calls) ──────────────────
    // CALL 'PROG-NAME' USING ...
    // CALL PROG-VAR USING ...
    let re_call = &*RE_COBOL_CALL;
    for cap in re_call.captures_iter(&upper) {
        let callee = cap[1].to_string();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        let caller = para_starts
            .iter()
            .rev()
            .find(|(_, start)| *start <= line)
            .map(|(n, _)| n.clone())
            .unwrap_or_else(|| "<program>".to_string());
        index.call_sites.push(CallSite {
            caller_function: caller,
            caller_line: line,
            callee_name: callee,
            callee_args_count: 0,
        });
    }

    // ── COPY statements → ImportInfo (copybook includes) ─────────────────────
    // COPY COPYBOOK-NAME.   or   COPY 'COPYBOOK.CPY'.
    let re_copy = &*RE_COBOL_COPY;
    for cap in re_copy.captures_iter(&upper) {
        let name = cap[1].to_string();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.imports.push(ImportInfo {
            source: name.clone(),
            names: vec![name],
            is_default: true,
            is_wildcard: false,
            line,
        });
    }
}

// ─── Fortran Extraction ──────────────────────────────────────────────────────
// Regex-based extractor for Fortran (.f, .f90, .f77, .for, .ftn files).
// Covers: programs, modules, subroutines, functions, USE imports, CALL statements.
//
// Fortran concepts → OPIDE index concepts:
//   PROGRAM name        → SymbolKind::Class
//   MODULE name         → SymbolKind::Class
//   SUBROUTINE name     → SymbolKind::Function
//   FUNCTION name       → SymbolKind::Function
//   USE module          → ImportInfo
//   CALL sub(args)      → CallSite

fn extract_fortran(source: &str, index: &mut FileIndex) {
    let upper = source.to_uppercase();
    let lines: Vec<&str> = source.lines().collect();

    // ── Programs ──────────────────────────────────────────────────────────────
    let re_program = &*RE_FORTRAN_PROGRAM;
    for cap in re_program.captures_iter(&upper) {
        let name = cap[1].to_string();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Class,
            start_line: line,
            end_line: lines.len(),
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── Modules ───────────────────────────────────────────────────────────────
    let re_module = &*RE_FORTRAN_MODULE;
    for cap in re_module.captures_iter(&upper) {
        let name = cap[1].to_string();
        if name == "PROCEDURE" { continue; } // MODULE PROCEDURE is different
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        let end_line = find_block_end(&lines, line.saturating_sub(1));
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Class,
            start_line: line,
            end_line,
            params: Vec::new(),
            return_type: None,
            exported: true,
        });
    }

    // ── Subroutines ───────────────────────────────────────────────────────────
    let re_sub = &*RE_FORTRAN_SUB;
    for cap in re_sub.captures_iter(&upper) {
        let name = cap[1].to_string();
        let params_raw = cap.get(2).map_or("", |m| m.as_str());
        let params: Vec<String> = params_raw
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        let end_line = find_block_end(&lines, line.saturating_sub(1));
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Function,
            start_line: line,
            end_line,
            params,
            return_type: None,
            exported: true,
        });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    let re_fun = &*RE_FORTRAN_FUN;
    for cap in re_fun.captures_iter(&upper) {
        let name = cap[1].to_string();
        if matches!(name.as_str(), "IF" | "WHILE" | "DO" | "SELECT") { continue; }
        let params_raw = cap.get(2).map_or("", |m| m.as_str());
        let params: Vec<String> = params_raw
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        let end_line = find_block_end(&lines, line.saturating_sub(1));
        index.symbols.push(Symbol {
            name,
            kind: SymbolKind::Function,
            start_line: line,
            end_line,
            params,
            return_type: None,
            exported: true,
        });
    }

    // ── USE imports ───────────────────────────────────────────────────────────
    let re_use = &*RE_FORTRAN_USE;
    for cap in re_use.captures_iter(&upper) {
        let name = cap[1].to_string();
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.imports.push(ImportInfo {
            source: name.clone(),
            names: vec![name],
            is_default: true,
            is_wildcard: false,
            line,
        });
    }

    // ── CALL statements ───────────────────────────────────────────────────────
    let re_call = &*RE_FORTRAN_CALL;
    for cap in re_call.captures_iter(&upper) {
        let callee = cap[1].to_string();
        if matches!(callee.as_str(), "SYSTEM" | "EXIT") { continue; }
        let line = byte_to_line(&upper, cap.get(0).unwrap().start());
        index.call_sites.push(CallSite {
            caller_function: "<module>".to_string(),
            caller_line: line,
            callee_name: callee,
            callee_args_count: 0,
        });
    }
}
