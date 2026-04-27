// ── Vector Index & Persistence ───────────────────────────────────────────────
// Stores code chunk embeddings for similarity search.
// Uses brute-force cosine similarity (fast enough for <10K chunks).
// Persists to disk so the index survives restarts.

use super::chunker::CodeChunk;
use super::types::ProjectIndex;
use serde::{Deserialize, Serialize};
use std::path::Path;

// ─── Search Result ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub file_path: String,
    pub name: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f32,
    pub text: String,
}

// ─── Code Index ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct CodeIndex {
    /// All chunks with their embeddings
    chunks: Vec<CodeChunk>,
    /// The project structure index (symbols, imports, exports)
    pub project: ProjectIndex,
    /// Call graph (A2)
    pub call_graph: super::call_graph::CallGraph,
    /// Type hierarchy (A3)
    pub type_graph: super::type_graph::TypeGraph,
    /// Embedding dimension (set from first embedding)
    dimension: usize,
    /// Workspace root path
    root: String,
}

impl CodeIndex {
    /// Create a new empty index.
    pub fn new(root: String, project: ProjectIndex) -> Self {
        let call_graph = super::call_graph::CallGraph::build(&project);
        let type_graph = super::type_graph::TypeGraph::build(&project);
        log::info!(
            "[indexer] Call graph: {} functions, {} edges | Type graph: {} types, {} relations",
            call_graph.function_count(),
            call_graph.edge_count(),
            type_graph.type_count(),
            type_graph.relation_count(),
        );
        Self {
            chunks: Vec::new(),
            project,
            call_graph,
            type_graph,
            dimension: 0,
            root,
        }
    }

    /// Add chunks to the index. Only chunks with embeddings are queryable.
    pub fn add_chunks(&mut self, chunks: Vec<CodeChunk>) {
        for chunk in chunks {
            if let Some(ref emb) = chunk.embedding {
                if self.dimension == 0 {
                    self.dimension = emb.len();
                }
            }
            self.chunks.push(chunk);
        }
    }

    /// Query the index for the top-k most similar chunks to a query embedding.
    pub fn query(&self, query_embedding: &[f32], k: usize) -> Vec<SearchResult> {
        let mut scored: Vec<(usize, f32)> = self.chunks
            .iter()
            .enumerate()
            .filter_map(|(i, chunk)| {
                chunk.embedding.as_ref().map(|emb| {
                    let score = cosine_similarity(query_embedding, emb);
                    (i, score)
                })
            })
            .collect();

        // Sort by score descending
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top-k
        scored
            .into_iter()
            .take(k)
            .map(|(i, score)| {
                let chunk = &self.chunks[i];
                SearchResult {
                    file_path: chunk.file_path.clone(),
                    name: chunk.name.clone(),
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    score,
                    text: chunk.text.clone(),
                }
            })
            .collect()
    }

    /// Replace all chunks with updated versions (e.g. after embedding).
    pub fn update_chunks(&mut self, chunks: Vec<super::chunker::CodeChunk>) {
        self.chunks = chunks;
    }

    /// Remove all chunks for a specific file (for incremental updates).
    pub fn remove_file(&mut self, file_path: &str) {
        self.chunks.retain(|c| c.file_path != file_path);
    }

    /// Get the number of indexed chunks.
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Read-only iterator over chunks (B177 cache lookup).
    pub fn chunks(&self) -> &[CodeChunk] {
        &self.chunks
    }

    /// Get the number of chunks with embeddings.
    pub fn embedded_count(&self) -> usize {
        self.chunks.iter().filter(|c| c.embedding.is_some()).count()
    }

    /// Get the embedding dimension.
    pub fn dimension(&self) -> usize {
        self.dimension
    }

    // ─── Persistence (Binary) ─────────────────────────────────────
    // Vectors: raw f32 bytes (vectors.bin)
    // Chunk metadata: binary length-prefixed format (chunks.bin)
    // Project structure: kept as JSON (small, human-readable for debugging)

    /// Save the index to disk at `{workspace}/.opide/index/`.
    pub fn save_to_disk(&self) -> Result<(), String> {
        let index_dir = Path::new(&self.root).join(".opide").join("index");
        std::fs::create_dir_all(&index_dir)
            .map_err(|e| format!("Failed to create index directory: {e}"))?;

        // ── Save vectors as raw f32 binary ──────────────────────────
        let vectors_path = index_dir.join("vectors.bin");
        let mut vectors_buf: Vec<u8> = Vec::new();
        // Header: [version: u8][dimension: u32 LE][count: u32 LE]
        vectors_buf.push(1); // version
        vectors_buf.extend_from_slice(&(self.dimension as u32).to_le_bytes());
        let embedded: Vec<&CodeChunk> = self.chunks.iter().filter(|c| c.embedding.is_some()).collect();
        vectors_buf.extend_from_slice(&(embedded.len() as u32).to_le_bytes());
        // Each vector: [chunk_index: u32 LE][f32 * dimension]
        for (i, chunk) in self.chunks.iter().enumerate() {
            if let Some(ref emb) = chunk.embedding {
                vectors_buf.extend_from_slice(&(i as u32).to_le_bytes());
                for &val in emb {
                    vectors_buf.extend_from_slice(&val.to_le_bytes());
                }
            }
        }
        std::fs::write(&vectors_path, &vectors_buf)
            .map_err(|e| format!("Failed to write vectors: {e}"))?;

        // ── Save chunk metadata as binary ───────────────────────────
        // Format per chunk: [path_len: u32][path][name_len: u32][name]
        //                   [start_line: u32][end_line: u32][kind: u8][lang: u8]
        //                   [text_len: u32][text]
        // B177: bump chunk binary format from v1 to v2. v2 appends a
        // u64 content_hash and a u8 skip_embedding flag per chunk so
        // the next index run can reuse embeddings keyed by hash.
        let chunks_path = index_dir.join("chunks.bin");
        let mut chunks_buf: Vec<u8> = Vec::new();
        chunks_buf.push(2); // version
        chunks_buf.extend_from_slice(&(self.chunks.len() as u32).to_le_bytes());
        for chunk in &self.chunks {
            write_len_prefixed_str(&mut chunks_buf, &chunk.file_path);
            write_len_prefixed_str(&mut chunks_buf, &chunk.name);
            chunks_buf.extend_from_slice(&(chunk.start_line as u32).to_le_bytes());
            chunks_buf.extend_from_slice(&(chunk.end_line as u32).to_le_bytes());
            chunks_buf.push(chunk_kind_to_u8(&chunk.kind));
            chunks_buf.push(language_to_u8(&chunk.language));
            write_len_prefixed_str(&mut chunks_buf, &chunk.text);
            chunks_buf.extend_from_slice(&chunk.content_hash.to_le_bytes());
            chunks_buf.push(if chunk.skip_embedding { 1 } else { 0 });
        }
        std::fs::write(&chunks_path, &chunks_buf)
            .map_err(|e| format!("Failed to write chunks: {e}"))?;

        // ── Save project structure (small, JSON is fine here) ───────
        let project_path = index_dir.join("project.json");
        let project_json = serde_json::to_string(&self.project)
            .map_err(|e| format!("Failed to serialize project: {e}"))?;
        std::fs::write(&project_path, &project_json)
            .map_err(|e| format!("Failed to write project: {e}"))?;

        // ── Save metadata header ────────────────────────────────────
        let meta_path = index_dir.join("meta.bin");
        let mut meta_buf: Vec<u8> = Vec::new();
        meta_buf.push(1); // version
        meta_buf.extend_from_slice(&(self.dimension as u32).to_le_bytes());
        meta_buf.extend_from_slice(&(self.chunks.len() as u32).to_le_bytes());
        meta_buf.extend_from_slice(&(self.project.file_count() as u32).to_le_bytes());
        meta_buf.extend_from_slice(&(self.project.symbol_count() as u32).to_le_bytes());
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        meta_buf.extend_from_slice(&created_at.to_le_bytes());
        std::fs::write(&meta_path, &meta_buf)
            .map_err(|e| format!("Failed to write meta: {e}"))?;

        log::info!(
            "[indexer] Saved index to disk (binary): {} chunks ({} embedded), {} files, vectors.bin={}KB",
            self.chunks.len(),
            embedded.len(),
            self.project.file_count(),
            vectors_buf.len() / 1024,
        );

        Ok(())
    }

    /// Load an index from disk. Returns None if no index exists.
    pub fn load_from_disk(root: &str) -> Option<Self> {
        let index_dir = Path::new(root).join(".opide").join("index");

        // Check metadata exists
        let meta_path = index_dir.join("meta.bin");
        if !meta_path.exists() {
            return None;
        }

        // ── Load metadata ───────────────────────────────────────────
        let meta_buf = std::fs::read(&meta_path).ok()?;
        if meta_buf.len() < 25 || meta_buf[0] != 1 { return None; }
        let dimension = u32::from_le_bytes([meta_buf[1], meta_buf[2], meta_buf[3], meta_buf[4]]) as usize;
        let _chunk_count = u32::from_le_bytes([meta_buf[5], meta_buf[6], meta_buf[7], meta_buf[8]]);
        // bytes 9-12: file_count, 13-16: symbol_count, 17-24: created_at (not needed for load)

        // ── Load chunk metadata ─────────────────────────────────────
        let chunks_path = index_dir.join("chunks.bin");
        let chunks_buf = std::fs::read(&chunks_path).ok()?;
        let chunks = read_chunks_binary(&chunks_buf)?;

        // ── Load vectors ────────────────────────────────────────────
        let vectors_path = index_dir.join("vectors.bin");
        let vectors_buf = std::fs::read(&vectors_path).ok()?;
        let mut chunks = chunks;
        read_vectors_binary(&vectors_buf, &mut chunks, dimension);

        // ── Load project ────────────────────────────────────────────
        let project_path = index_dir.join("project.json");
        let project_json = std::fs::read_to_string(&project_path).ok()?;
        let project: ProjectIndex = serde_json::from_str(&project_json).ok()?;

        let embedded_count = chunks.iter().filter(|c| c.embedding.is_some()).count();
        log::info!(
            "[indexer] Loaded index from disk: {} chunks ({} embedded), {} files, dim={}",
            chunks.len(), embedded_count, project.file_count(), dimension,
        );

        let call_graph = super::call_graph::CallGraph::build(&project);
        let type_graph = super::type_graph::TypeGraph::build(&project);
        Some(Self {
            chunks,
            project,
            call_graph,
            type_graph,
            dimension,
            root: root.to_string(),
        })
    }

    /// Check if the disk index is stale (files have changed since indexing).
    pub fn is_stale(root: &str) -> bool {
        let index_dir = Path::new(root).join(".opide").join("index");
        let meta_path = index_dir.join("meta.bin");

        if !meta_path.exists() {
            return true;
        }

        let meta_buf = match std::fs::read(&meta_path) {
            Ok(b) => b,
            Err(_) => return true,
        };

        if meta_buf.len() < 25 || meta_buf[0] != 1 {
            return true;
        }

        // created_at is at bytes 17-24 (u64 LE)
        let created_at = u64::from_le_bytes([
            meta_buf[17], meta_buf[18], meta_buf[19], meta_buf[20],
            meta_buf[21], meta_buf[22], meta_buf[23], meta_buf[24],
        ]);

        let index_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(created_at);

        let walker = ignore::WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .max_depth(Some(20))
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if path.is_dir() {
                continue;
            }

            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !super::types::Language::from_extension(ext).is_parseable() {
                continue;
            }

            if let Ok(metadata) = std::fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    if modified > index_time {
                        return true;
                    }
                }
            }
        }

        false
    }
}

// ─── Binary Read/Write Helpers ───────────────────────────────────────────────

fn write_len_prefixed_str(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

fn read_len_prefixed_str(buf: &[u8], offset: &mut usize) -> Option<String> {
    if *offset + 4 > buf.len() { return None; }
    let len = u32::from_le_bytes([buf[*offset], buf[*offset+1], buf[*offset+2], buf[*offset+3]]) as usize;
    *offset += 4;
    if *offset + len > buf.len() { return None; }
    let s = String::from_utf8_lossy(&buf[*offset..*offset + len]).to_string();
    *offset += len;
    Some(s)
}

fn read_u32(buf: &[u8], offset: &mut usize) -> Option<u32> {
    if *offset + 4 > buf.len() { return None; }
    let val = u32::from_le_bytes([buf[*offset], buf[*offset+1], buf[*offset+2], buf[*offset+3]]);
    *offset += 4;
    Some(val)
}

fn chunk_kind_to_u8(kind: &super::chunker::ChunkKind) -> u8 {
    use super::chunker::ChunkKind;
    match kind {
        ChunkKind::Function => 0,
        ChunkKind::Component => 1,
        ChunkKind::Class => 2,
        ChunkKind::Interface => 3,
        ChunkKind::Type => 4,
        ChunkKind::Enum => 5,
        ChunkKind::Method => 6,
        ChunkKind::Imports => 7,
        ChunkKind::FileRemainder => 8,
    }
}

fn u8_to_chunk_kind(val: u8) -> super::chunker::ChunkKind {
    use super::chunker::ChunkKind;
    match val {
        0 => ChunkKind::Function,
        1 => ChunkKind::Component,
        2 => ChunkKind::Class,
        3 => ChunkKind::Interface,
        4 => ChunkKind::Type,
        5 => ChunkKind::Enum,
        6 => ChunkKind::Method,
        7 => ChunkKind::Imports,
        _ => ChunkKind::FileRemainder,
    }
}

fn language_to_u8(lang: &super::types::Language) -> u8 {
    use super::types::Language;
    match lang {
        Language::TypeScript => 0,
        Language::TypeScriptReact => 1,
        Language::JavaScript => 2,
        Language::JavaScriptReact => 3,
        Language::Rust => 4,
        Language::Python => 5,
        Language::Css => 6,
        Language::Json => 7,
        Language::Solidity => 8,
        Language::Move => 14,
        Language::Go => 9,
        Language::C => 10,
        Language::Cpp => 11,
        Language::Java => 12,
        Language::Ruby => 13,
        Language::Cobol => 15,
        Language::Fortran => 16,
        Language::Unknown => 255,
    }
}

fn u8_to_language(val: u8) -> super::types::Language {
    use super::types::Language;
    match val {
        0 => Language::TypeScript,
        1 => Language::TypeScriptReact,
        2 => Language::JavaScript,
        3 => Language::JavaScriptReact,
        4 => Language::Rust,
        5 => Language::Python,
        6 => Language::Css,
        7 => Language::Json,
        8 => Language::Solidity,
        9 => Language::Go,
        10 => Language::C,
        11 => Language::Cpp,
        12 => Language::Java,
        13 => Language::Ruby,
        14 => Language::Move,
        15 => Language::Cobol,
        16 => Language::Fortran,
        _ => Language::Unknown,
    }
}

fn read_chunks_binary(buf: &[u8]) -> Option<Vec<CodeChunk>> {
    let mut offset = 0;
    if buf.is_empty() {
        return None;
    }
    let version = buf[0];
    if version != 1 && version != 2 {
        return None;
    }
    offset += 1;

    let count = read_u32(buf, &mut offset)? as usize;
    let mut chunks = Vec::with_capacity(count);

    for _ in 0..count {
        let file_path = read_len_prefixed_str(buf, &mut offset)?;
        let name = read_len_prefixed_str(buf, &mut offset)?;
        let start_line = read_u32(buf, &mut offset)? as usize;
        let end_line = read_u32(buf, &mut offset)? as usize;
        if offset >= buf.len() { return None; }
        let kind = u8_to_chunk_kind(buf[offset]);
        offset += 1;
        if offset >= buf.len() { return None; }
        let language = u8_to_language(buf[offset]);
        offset += 1;
        let text = read_len_prefixed_str(buf, &mut offset)?;

        // B177: v2 appends content_hash + skip_embedding. v1 chunks
        // get hash=0 (cache lookup will skip them) and skip_embedding=false.
        let (content_hash, skip_embedding) = if version >= 2 {
            if offset + 8 > buf.len() {
                return None;
            }
            let mut hash_bytes = [0u8; 8];
            hash_bytes.copy_from_slice(&buf[offset..offset + 8]);
            offset += 8;
            let hash = u64::from_le_bytes(hash_bytes);
            if offset >= buf.len() {
                return None;
            }
            let skip = buf[offset] != 0;
            offset += 1;
            (hash, skip)
        } else {
            (0u64, false)
        };

        chunks.push(CodeChunk {
            file_path,
            language,
            start_line,
            end_line,
            kind,
            name,
            text,
            embedding: None, // loaded separately from vectors.bin
            content_hash,
            skip_embedding,
        });
    }

    Some(chunks)
}

fn read_vectors_binary(buf: &[u8], chunks: &mut Vec<CodeChunk>, dimension: usize) {
    if buf.len() < 9 || buf[0] != 1 { return; }
    let mut offset = 1;
    let _dim = read_u32(buf, &mut offset).unwrap_or(0) as usize;
    let count = read_u32(buf, &mut offset).unwrap_or(0) as usize;

    let vector_bytes = dimension * 4; // f32 = 4 bytes

    for _ in 0..count {
        if offset + 4 + vector_bytes > buf.len() { break; }
        let chunk_idx = read_u32(buf, &mut offset).unwrap_or(0) as usize;

        let mut vector = Vec::with_capacity(dimension);
        for _ in 0..dimension {
            if offset + 4 > buf.len() { break; }
            let val = f32::from_le_bytes([buf[offset], buf[offset+1], buf[offset+2], buf[offset+3]]);
            offset += 4;
            vector.push(val);
        }

        if chunk_idx < chunks.len() && vector.len() == dimension {
            chunks[chunk_idx].embedding = Some(vector);
        }
    }
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}
