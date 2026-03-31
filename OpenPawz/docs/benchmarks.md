# Performance Benchmarks

OpenPawz ships a dedicated benchmark crate (`openpawz-bench`) powered by
[Criterion.rs](https://bheisler.github.io/criterion.rs/book/) that measures
every performance-critical path in the engine — from SQLite session ops and
memory search to HNSW vector indexing, injection scanning, and cryptographic
operations.

## Why Benchmark?

| Goal | What It Catches |
|------|-----------------|
| **Regression detection** | A refactor silently doubles BM25 search time |
| **Capacity planning** | How fast can we insert 2 000 HNSW vectors? |
| **Optimization targeting** | Know *which* function is the bottleneck before optimizing |
| **Comparing algorithms** | HNSW search vs brute-force at 1 000 vectors |
| **CI gating** | Fail a PR if a critical path regresses beyond a threshold |

## Benchmark Suites

The crate contains **6 bench files** covering **100+ individual benchmarks**:

### session_bench

Sessions, messages, tasks, and agent file I/O.

| Benchmark | What It Measures |
|-----------|-----------------|
| `session/create` | Create a new chat session (SQLite INSERT) |
| `session/list/{10,100,500}` | List sessions at varying DB sizes |
| `message/add` | Add a message with HMAC chain verification |
| `message/get/{50,200,1000}` | Fetch messages at varying depths |
| `task/create` | Create a scheduled task |
| `task/list_200` | List 200 tasks with full deserialization |
| `agent/file_set` | Write an agent file (SOUL, instructions) |
| `agent/file_get` | Read an agent file by key |

### memory_bench

Memory store, BM25 search, knowledge graph, episodic and semantic memory
subsystems.

| Benchmark | What It Measures |
|-----------|-----------------|
| `memory/store` | Insert a memory record |
| `memory/search_keyword` | Keyword (LIKE) search |
| `memory/search_bm25` | BM25 ranked full-text search |
| `memory/list/{20,100,500}` | List memories at scale |
| `memory/stats` | Aggregate memory statistics |
| `graph/relate` | Create an edge between two memory nodes |
| `graph/apply_decay` | Time-decay pass over the graph |
| `graph/garbage_collect` | Remove orphaned nodes |
| `graph/store_procedural` | Insert procedural (how-to) memory |
| `graph/spreading_activation` | Spreading activation over the graph |
| `graph/community_detection` | Louvain-style community detection |
| `episodic/store` | Insert an episodic memory |
| `episodic/get` | Fetch a single episodic memory |
| `episodic/batch_get/{10,50,200}` | Batch fetch at varying sizes |
| `episodic/search_bm25/{20,100,500}` | BM25 over episodic memories |
| `episodic/search_vector` | Vector similarity search (cosine) |
| `semantic/store` | Insert a semantic memory |
| `semantic/search_bm25` | BM25 over semantic memories |
| `memory/extract_facts/{preference,context,instruction}` | Fact extraction by type |
| `episodic/gc_candidates/{50,200,1000}` | Identify GC candidates at scale |

### engram_bench

HNSW vector index, reranking, hybrid search, abstraction tree, tokenizer,
sensory buffer, working memory, affect system, intent classification, entity
extraction, temporal scoring, recall tuning, gated search, and model
capabilities.

| Benchmark | What It Measures |
|-----------|-----------------|
| `hnsw/insert/{100,500,2000}` | Build an HNSW index at varying sizes |
| `hnsw/search/{100,1000,5000}` | ANN search at varying index sizes |
| `hnsw/vs_brute_force_1k` | Compare HNSW vs linear scan at 1 000 vectors |
| `reranking/rrf` | Reciprocal Rank Fusion |
| `reranking/mmr` | Maximal Marginal Relevance |
| `hybrid/resolve_weight` | Resolve hybrid search weight |
| `hybrid/weighted_rrf_fuse` | Weighted RRF fusion |
| `abstraction/build_tree` | Build a hierarchical abstraction tree |
| `abstraction/pack_with_fallback` | Token-budget packing |
| `abstraction/select_level` | Select abstraction level |
| `tokenizer/count_tokens/{Cl100kBase,O200kBase,Heuristic}` | Token counting by encoding |
| `tokenizer/truncate_to_budget` | Truncate text to a token budget |
| `sensory/push` | Push to the sensory buffer |
| `sensory/format_for_context` | Format sensory buffer for LLM context |
| `working_mem/insert_recall` | Working memory insert + recall |
| `working_mem/decay_priorities` | Priority decay pass |
| `working_mem/format_for_context` | Format working memory for context |
| `intent_classify/{factual,procedural,causal,exploratory,episodic}` | Intent classification |
| `entity_extract/{short,medium,long}` | Named entity extraction |
| `metadata_infer` / `metadata_infer_full` | Metadata inference |
| `metadata_detect_lang/{rust,python,typescript}` | Programming language detection |
| `temporal_recency_score/{1h,24h,7d,30d}` | Recency scoring at different ages |
| `temporal_cluster` | Temporal clustering |
| `recall_tuner_observe_and_tune` | Adaptive recall tuning |
| `quality_compute_ndcg` / `quality_average_relevancy` | Retrieval quality metrics |
| `gate_decision/{skip_greeting,retrieve_factual,...}` | Gated search decisions |
| `model_caps_resolve/{gpt4o,claude,llama,unknown}` | Model capability resolution |
| `model_caps_normalize_name` | Normalize model name strings |

### security_bench

Injection scanning, PII detection, encryption, constrained decoding, key
derivation, differential privacy, and score quantization.

| Benchmark | What It Measures |
|-----------|-----------------|
| `injection/scan/{short,medium,long}` | Injection scan at varying input sizes |
| `injection/scan_clean` | Scan a clean (no-injection) input |
| `injection/is_likely_injection` | Quick heuristic injection check |
| `pii/detect` | PII detection (emails, SSNs, cards) |
| `encrypt/round_trip` | AES-256-GCM encrypt + decrypt |
| `decrypt/only` | Decrypt only |
| `constrained/detect` | Constrained output detection |
| `constrained/normalize` | Token normalization |
| `constrained/apply_strict` | Apply strict constraints |
| `derive_agent_key` | Argon2-based key derivation |
| `prepare_for_storage/{standard,sensitive,critical}` | Tiered storage preparation |
| `dp_noise/{eps_1,eps_0.1,eps_10}` | Differential privacy noise at varying epsilon |
| `quantize_score` | Score quantization |

### audit_bench

Tamper-evident audit log and Software Composition Certificates.

| Benchmark | What It Measures |
|-----------|-----------------|
| `audit/append` | Append an HMAC-chained audit entry |
| `audit/verify_chain/{100,1000,5000}` | Verify chain integrity at scale |
| `audit/query_recent` | Query recent audit entries |
| `audit/stats` | Aggregate audit statistics |
| `scc/issue_certificate` | Issue a capability certificate |
| `scc/verify_certificate` | Verify a certificate |

### reasoning_bench

Affect scoring, emotional context, pricing, task complexity, and tool metadata.

| Benchmark | What It Measures |
|-----------|-----------------|
| `affect/score_affect` | Score emotional affect of text |
| `affect/modulated_encoding` | Affect-modulated memory encoding |
| `affect/congruent_boost` | Mood-congruent retrieval boost |
| `affect/to_emotional_context` | Convert affect to emotional context |
| `pricing/model_price` | Look up model pricing |
| `pricing/estimate_cost` | Estimate token cost |
| `classify_task_complexity` | Classify task complexity tier |
| `tool_metadata/get` | Retrieve tool metadata |
| `tool_metadata/tier` | Resolve tool safety tier |
| `tool_metadata/domain` | Resolve tool domain |

## Running Benchmarks

All commands assume you're in the `src-tauri/` directory.

### Quick Timing (Built-in)

Runs a fast, self-contained timing loop — no Criterion overhead. Good for a
quick sanity check:

```bash
openpawz bench quick                  # 100 iterations (default)
openpawz bench quick --iterations 500 # 500 iterations
openpawz bench quick --output json    # Machine-readable output
```

### Full Criterion Suite

Runs the statistically rigorous Criterion suite with 100 samples per benchmark:

```bash
openpawz bench full                           # Run all 6 suites
openpawz bench full --bench session_bench     # Just session benchmarks
openpawz bench full --bench engram_bench hnsw # Filter to HNSW within engram
```

Or run directly with cargo:

```bash
cargo bench -p openpawz-bench                           # All suites
cargo bench -p openpawz-bench --bench memory_bench      # One suite
cargo bench -p openpawz-bench --bench engram_bench -- hnsw  # Filter
```

### Generate a Report

Parse Criterion's saved results and produce a Markdown report:

```bash
openpawz bench report                            # → benchmarks-report.md
openpawz bench report -o perf-report.md          # Custom output path
openpawz bench report --run-first                # Run benchmarks, then report
openpawz bench report --run-first --bench session_bench  # Run one suite first
openpawz bench report --output json              # Print JSON to stdout
```

The report includes:

- **Summary table** — count, fastest, and slowest per category
- **Detailed tables** — mean, median, and std dev for every benchmark
- **Top 10 slowest** — optimization targets at a glance
- **Top 10 fastest** — sanity check for sub-microsecond operations

### HTML Reports

Criterion automatically generates interactive HTML reports with charts:

```
target/criterion/report/index.html   # Overview
target/criterion/<bench>/report/     # Per-benchmark detail
```

Open them in a browser:

```bash
open target/criterion/report/index.html   # macOS
xdg-open target/criterion/report/index.html  # Linux
```

## Understanding Results

Each Criterion benchmark reports three timing values:

| Value | Meaning |
|-------|---------|
| **Mean** | Average across all samples |
| **Median** | 50th percentile — less sensitive to outliers |
| **Std Dev** | Spread — high values indicate noisy measurements |

### What's Normal?

| Operation Type | Expected Range |
|---------------|---------------|
| In-memory lookups (tokenizer, affect, intent) | < 10 µs |
| Single SQLite reads | 5–50 µs |
| Single SQLite writes | 10–100 µs |
| BM25 / keyword search | 15–60 µs |
| HMAC-chained message add | 500–1000 µs |
| HNSW search (1 000 vectors) | 300–500 µs |
| HNSW insert (2 000 vectors) | 1–3 s |
| Community detection (graph) | 100–300 µs |
| AES-256-GCM encrypt | 5–15 µs |
| Argon2 key derivation | 10–50 ms |

### The "Gnuplot not found" Message

```
Gnuplot not found, using plotters backend
```

This is **harmless**. Criterion prefers gnuplot for HTML chart rendering but
falls back to plotters (a pure-Rust alternative) automatically. The benchmark
numbers are identical. To silence it:

```bash
brew install gnuplot   # macOS
sudo apt install gnuplot  # Debian/Ubuntu
```

## Tips

- **Consistent environment**: Close browsers and heavy apps before benchmarking.
  Criterion takes 100 samples, so transient load can cause outliers.
- **Warm the cache**: Run the suite twice. The first run populates OS file
  caches; the second gives more stable numbers.
- **Filter for speed**: Use `openpawz bench full --bench session_bench` to run
  just one suite when iterating on a specific module.
- **Regression tracking**: Save reports periodically
  (`openpawz bench report -o bench-2026-03-17.md`) and diff them to catch
  regressions.
- **CI integration**: Compare the `--output json` format programmatically
  against a baseline.
