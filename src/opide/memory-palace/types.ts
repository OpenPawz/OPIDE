// Memory Palace — TS types mirroring backend serde shapes.
//
// These mirror the Rust types in `crates/opide-engine/src/atoms/{types,engram_types}.rs`
// and the JSON shape returned by `engine_memory_embedding_projection` in
// `crates/opide-engine/src/commands/memory.rs`. Keep them in sync if the
// backend types change.

// ── Core memory record ──────────────────────────────────────────────────────

/** A memory row as returned by `engine_memory_*` commands. */
export interface EngineMemory {
  id: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
  /** Cosine similarity (only present in search results). */
  score?: number;
  /** Owning agent id (None / undefined = shared/global). */
  agent_id?: string;
}

/** Aggregate stats from `engine_memory_stats`. */
export interface EngineMemoryStats {
  total_memories: number;
  categories: [string, number][];
  has_embeddings: boolean;
}

/** Embedding provider tag — matches the Rust `EmbeddingProvider` enum. */
export type EmbeddingProvider = 'auto' | 'ollama' | 'openai' | 'google' | 'provider';

/** Memory subsystem config from `engine_get_memory_config`. */
export interface EngineMemoryConfig {
  embedding_provider: EmbeddingProvider;
  embedding_base_url: string;
  embedding_model: string;
  embedding_dims: number;
  auto_recall: boolean;
  auto_capture: boolean;
  recall_limit: number;
  recall_threshold: number;
}

// ── Knowledge graph edges ──────────────────────────────────────────────────

/** A typed edge between two memories — from `engine_memory_edges`. */
export interface MemoryEdge {
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
  created_at: string;
}

// ── Embedding projection (Memory Atlas scatter plot) ───────────────────────

/** A point in the 3D embedding projection. Backend embeds metadata for display. */
export interface ProjectedPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  content: string;
  category: string;
  importance: number;
  created_at: string;
}

/** A category cluster summary in the projection. */
export interface EmbeddingCluster {
  id: string;
  count: number;
}

/** A projected edge between two points (lighter shape than `MemoryEdge`). */
export interface ProjectedEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

/** Full payload from `engine_memory_embedding_projection`. */
export interface EmbeddingProjection {
  points: ProjectedPoint[];
  clusters: EmbeddingCluster[];
  edges: ProjectedEdge[];
  total: number;
  has_embeddings: boolean;
}
