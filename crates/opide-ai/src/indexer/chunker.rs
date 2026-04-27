// ── Code Chunker ─────────────────────────────────────────────────────────────
// Splits source files into meaningful chunks for embedding.
// Each chunk is a unit of code that makes sense on its own:
// functions, classes, types, or file-level code.

use super::types::*;
use serde::{Deserialize, Serialize};

/// A code chunk ready for embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeChunk {
    pub file_path: String,
    pub language: Language,
    pub start_line: usize,
    pub end_line: usize,
    pub kind: ChunkKind,
    pub name: String,          // e.g. "Button", "fetchUsers", "ButtonProps"
    pub text: String,          // the actual code
    pub embedding: Option<Vec<f32>>,
    /// B177: stable hash of `text`. The indexer skips embedding when a
    /// chunk's hash matches an entry in the persisted cache.
    #[serde(default)]
    pub content_hash: u64,
    /// B182: when the source file was over EMBED_CAP, the embedding
    /// step skips this chunk; AST/symbol queries still work.
    #[serde(default)]
    pub skip_embedding: bool,
}

/// Compute a stable 64-bit hash of chunk content for incremental
/// re-embedding (B177). DefaultHasher is good enough for this — we only
/// need stability across runs of the same binary, not collision
/// resistance against adversaries.
pub fn chunk_content_hash(text: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChunkKind {
    Function,
    Component,
    Class,
    Interface,
    Type,
    Enum,
    Method,
    Imports,       // all imports grouped as one chunk
    FileRemainder, // everything else (constants, config, etc.)
}

/// Split a file into chunks based on its parsed symbols.
pub fn chunk_file(file: &FileIndex, content: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    if lines.is_empty() {
        return chunks;
    }

    // Track which lines are covered by symbol chunks
    let mut covered_lines = vec![false; lines.len()];

    // Create a chunk for each symbol
    for symbol in &file.symbols {
        let start = symbol.start_line.saturating_sub(1); // 1-indexed to 0-indexed
        let end = symbol.end_line.min(lines.len());

        if start >= lines.len() || start >= end {
            continue;
        }

        let chunk_text = lines[start..end].join("\n");

        // Skip tiny chunks (single-line variable declarations, etc.)
        if chunk_text.len() < 20 && !matches!(symbol.kind, SymbolKind::Type | SymbolKind::Interface) {
            continue;
        }

        let kind = match symbol.kind {
            SymbolKind::Function => ChunkKind::Function,
            SymbolKind::Component => ChunkKind::Component,
            SymbolKind::Class => ChunkKind::Class,
            SymbolKind::Struct => ChunkKind::Class,
            SymbolKind::Interface => ChunkKind::Interface,
            SymbolKind::Type => ChunkKind::Type,
            SymbolKind::Enum => ChunkKind::Enum,
            SymbolKind::Method => ChunkKind::Method,
            SymbolKind::Variable | SymbolKind::Constant => ChunkKind::FileRemainder,
        };

        // Prefix with file path for context when embedded
        let prefixed_text = format!("// {}\n{}", file.path, chunk_text);

        let hash = chunk_content_hash(&prefixed_text);
        chunks.push(CodeChunk {
            file_path: file.path.clone(),
            language: file.language,
            start_line: symbol.start_line,
            end_line: symbol.end_line,
            kind,
            name: symbol.name.clone(),
            text: prefixed_text,
            embedding: None,
            content_hash: hash,
            skip_embedding: file.skip_embedding,
        });

        // Mark lines as covered
        for i in start..end {
            if i < covered_lines.len() {
                covered_lines[i] = true;
            }
        }
    }

    // Create an imports chunk if there are imports
    if !file.imports.is_empty() {
        let import_lines: Vec<String> = file.imports.iter().map(|imp| {
            if imp.names.is_empty() {
                format!("import {}", imp.source)
            } else {
                format!("import {{ {} }} from \"{}\"", imp.names.join(", "), imp.source)
            }
        }).collect();

        let imports_text = format!("// {} imports\n{}", file.path, import_lines.join("\n"));
        let imports_hash = chunk_content_hash(&imports_text);
        chunks.push(CodeChunk {
            file_path: file.path.clone(),
            language: file.language,
            start_line: file.imports.first().map_or(1, |i| i.line),
            end_line: file.imports.last().map_or(1, |i| i.line),
            kind: ChunkKind::Imports,
            name: format!("{} imports", file.path),
            text: imports_text,
            embedding: None,
            content_hash: imports_hash,
            skip_embedding: file.skip_embedding,
        });
    }

    // Create a remainder chunk for uncovered lines (if substantial)
    let mut remainder_lines = Vec::new();
    let mut remainder_start = None;
    let mut remainder_end = 0;

    for (i, &covered) in covered_lines.iter().enumerate() {
        if !covered {
            let line = lines[i].trim();
            // Skip empty lines and pure import lines (already chunked)
            if !line.is_empty() && !line.starts_with("import ") && !line.starts_with("use ") {
                if remainder_start.is_none() {
                    remainder_start = Some(i + 1);
                }
                remainder_end = i + 1;
                remainder_lines.push(lines[i]);
            }
        }
    }

    if remainder_lines.len() >= 3 {
        let text = format!("// {} (file-level code)\n{}", file.path, remainder_lines.join("\n"));
        let hash = chunk_content_hash(&text);
        chunks.push(CodeChunk {
            file_path: file.path.clone(),
            language: file.language,
            start_line: remainder_start.unwrap_or(1),
            end_line: remainder_end,
            kind: ChunkKind::FileRemainder,
            name: format!("{} (file-level)", file.path),
            text,
            embedding: None,
            content_hash: hash,
            skip_embedding: file.skip_embedding,
        });
    }

    chunks
}

/// Chunk all files in a project index.
pub fn chunk_project(project: &ProjectIndex, root: &std::path::Path) -> Vec<CodeChunk> {
    let mut all_chunks = Vec::new();

    for file in &project.files {
        let full_path = root.join(&file.path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let chunks = chunk_file(file, &content);
        all_chunks.extend(chunks);
    }

    all_chunks
}
