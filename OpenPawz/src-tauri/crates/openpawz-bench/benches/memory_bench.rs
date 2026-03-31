use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use openpawz_bench::*;
use openpawz_core::atoms::engram_types::{
    ConsolidationState, EdgeType, EpisodicMemory, MemoryScope, MemorySource, ProceduralMemory,
    ProceduralStep, SemanticMemory, TieredContent,
};
use openpawz_core::engine::engram;
use openpawz_core::engine::memory;
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};

static MEM_CTR: AtomicU64 = AtomicU64::new(0);
static RELATE_CTR: AtomicU64 = AtomicU64::new(0);
static PROC_CTR: AtomicU64 = AtomicU64::new(0);
static EP_CTR: AtomicU64 = AtomicU64::new(0);
static SEM_CTR: AtomicU64 = AtomicU64::new(0);

// ── SessionStore memory methods ──────────────────────────────────────────

fn bench_store_memory(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("memory/store", |b| {
        b.iter(|| {
            let i = MEM_CTR.fetch_add(1, Ordering::Relaxed);
            store
                .store_memory(
                    &format!("m-{}", i),
                    MEMORY_CORPUS[(i as usize) % MEMORY_CORPUS.len()],
                    "fact",
                    5,
                    None,
                    Some("bench-agent"),
                )
                .unwrap();
        });
    });
}

fn bench_search_keyword(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        store
            .store_memory(&format!("sk-{}", i), content, "fact", 5, None, Some("a"))
            .unwrap();
    }
    c.bench_function("memory/search_keyword", |b| {
        b.iter(|| {
            black_box(
                store
                    .search_memories_keyword(black_box("kubernetes"), 10)
                    .unwrap(),
            )
        });
    });
}

fn bench_search_bm25(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        store
            .store_memory(&format!("bm-{}", i), content, "fact", 5, None, Some("a"))
            .unwrap();
    }
    c.bench_function("memory/search_bm25", |b| {
        b.iter(|| {
            black_box(
                store
                    .search_memories_bm25(black_box("deployment scaling"), 10, None)
                    .unwrap(),
            )
        });
    });
}

fn bench_list_memories(c: &mut Criterion) {
    let mut group = c.benchmark_group("memory/list");
    for &count in &[20, 100, 500] {
        let store = fresh_store();
        for i in 0..count {
            store
                .store_memory(
                    &format!("lm-{}", i),
                    MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                    "fact",
                    3,
                    None,
                    None,
                )
                .unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| black_box(store.list_memories(black_box(count)).unwrap().len()));
        });
    }
    group.finish();
}

fn bench_memory_stats(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        store
            .store_memory(&format!("ms-{}", i), content, "fact", 5, None, Some("a"))
            .unwrap();
    }
    c.bench_function("memory/stats", |b| {
        b.iter(|| black_box(store.memory_stats().unwrap()));
    });
}

// ── Engram graph (sync fns) ─────────────────────────────────────────────

fn bench_graph_relate(c: &mut Criterion) {
    let store = fresh_store();
    // Seed some memories for edges.
    for i in 0..50 {
        store
            .store_memory(
                &format!("gr-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                "fact",
                5,
                None,
                None,
            )
            .unwrap();
    }
    c.bench_function("graph/relate", |b| {
        b.iter(|| {
            let i = RELATE_CTR.fetch_add(1, Ordering::Relaxed);
            let a = i % 50;
            let b_idx = (i + 7) % 50;
            engram::relate(
                &store,
                &format!("gr-{}", a),
                &format!("gr-{}", b_idx),
                EdgeType::RelatedTo,
                0.8,
            )
            .unwrap();
        });
    });
}

fn bench_graph_decay(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..100 {
        store
            .store_memory(
                &format!("gd-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                "fact",
                5,
                None,
                None,
            )
            .unwrap();
    }
    c.bench_function("graph/apply_decay", |b| {
        b.iter(|| black_box(engram::apply_decay(&store, 7.0).unwrap()));
    });
}

fn bench_graph_gc(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..100 {
        store
            .store_memory(
                &format!("gc-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                "fact",
                1,
                None,
                None,
            )
            .unwrap();
    }
    c.bench_function("graph/garbage_collect", |b| {
        b.iter(|| black_box(engram::garbage_collect(&store, 0, 50, None).unwrap()));
    });
}

fn bench_graph_stats(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..50 {
        store
            .store_memory(
                &format!("gs-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                "fact",
                5,
                None,
                None,
            )
            .unwrap();
    }
    c.bench_function("graph/memory_stats", |b| {
        b.iter(|| black_box(engram::memory_stats(&store).unwrap()));
    });
}

fn bench_store_procedural(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("graph/store_procedural", |b| {
        b.iter(|| {
            let i = PROC_CTR.fetch_add(1, Ordering::Relaxed);
            let mem = ProceduralMemory {
                id: format!("proc-{}", i),
                trigger: "user asks to deploy".into(),
                steps: vec![
                    ProceduralStep {
                        description: "Run tests".into(),
                        tool_name: Some("execute_command".into()),
                        args_pattern: Some("cargo test".into()),
                        expected_outcome: None,
                    },
                    ProceduralStep {
                        description: "Build release".into(),
                        tool_name: Some("execute_command".into()),
                        args_pattern: Some("cargo build --release".into()),
                        expected_outcome: None,
                    },
                ],
                success_rate: 0.9,
                execution_count: 5,
                scope: MemoryScope {
                    global: false,
                    project_id: None,
                    squad_id: None,
                    agent_id: Some("bench-agent".into()),
                    channel: None,
                    channel_user_id: None,
                },
                created_at: now(),
                updated_at: None,
            };
            engram::store_procedural(&store, &mem).unwrap();
        });
    });
}

// ── Episodic memory CRUD ─────────────────────────────────────────────────

fn make_episodic(id: &str, content: &str) -> EpisodicMemory {
    EpisodicMemory {
        id: id.into(),
        content: TieredContent::from_text(content),
        category: "fact".into(),
        importance: 0.7,
        agent_id: "bench-agent".into(),
        session_id: "bench-session".into(),
        source: MemorySource::default(),
        consolidation_state: ConsolidationState::Fresh,
        scope: MemoryScope {
            global: false,
            project_id: None,
            squad_id: None,
            agent_id: Some("bench-agent".into()),
            channel: None,
            channel_user_id: None,
        },
        created_at: now(),
        ..Default::default()
    }
}

fn bench_episodic_store(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("episodic/store", |b| {
        b.iter(|| {
            let i = EP_CTR.fetch_add(1, Ordering::Relaxed);
            let mem = make_episodic(
                &format!("ep-{}", i),
                MEMORY_CORPUS[(i as usize) % MEMORY_CORPUS.len()],
            );
            store.engram_store_episodic(black_box(&mem)).unwrap();
        });
    });
}

fn bench_episodic_get(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        store
            .engram_store_episodic(&make_episodic(&format!("eg-{}", i), content))
            .unwrap();
    }
    c.bench_function("episodic/get", |b| {
        let mut i = 0usize;
        b.iter(|| {
            i = (i + 1) % MEMORY_CORPUS.len();
            black_box(
                store
                    .engram_get_episodic(black_box(&format!("eg-{}", i)))
                    .unwrap(),
            );
        });
    });
}

fn bench_episodic_batch_get(c: &mut Criterion) {
    let mut group = c.benchmark_group("episodic/batch_get");
    for &count in &[10, 50, 200] {
        let store = fresh_store();
        let mut ids = Vec::new();
        for i in 0..count {
            let id = format!("eb-{}", i);
            store
                .engram_store_episodic(&make_episodic(&id, MEMORY_CORPUS[i % MEMORY_CORPUS.len()]))
                .unwrap();
            ids.push(id);
        }
        group.bench_with_input(
            BenchmarkId::from_parameter(count),
            &(store, ids),
            |b, (store, ids)| {
                b.iter(|| black_box(store.engram_get_episodic_batch(black_box(ids)).unwrap()));
            },
        );
    }
    group.finish();
}

fn bench_episodic_search_bm25(c: &mut Criterion) {
    let mut group = c.benchmark_group("episodic/search_bm25");
    for &count in &[20, 100, 500] {
        let store = fresh_store();
        for i in 0..count {
            store
                .engram_store_episodic(&make_episodic(
                    &format!("esb-{}", i),
                    MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                ))
                .unwrap();
        }
        let scope = MemoryScope::default();
        group.bench_with_input(
            BenchmarkId::from_parameter(count),
            &(store, scope),
            |b, (store, scope)| {
                b.iter(|| {
                    black_box(
                        store
                            .engram_search_episodic_bm25(
                                black_box("kubernetes deployment scaling"),
                                scope,
                                10,
                            )
                            .unwrap(),
                    )
                });
            },
        );
    }
    group.finish();
}

fn bench_episodic_search_vector(c: &mut Criterion) {
    let store = fresh_store();
    let model = "bench-model";
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        let mut mem = make_episodic(&format!("esv-{}", i), content);
        mem.embedding = Some(random_vec(384));
        mem.embedding_model = Some(model.into());
        store.engram_store_episodic(&mem).unwrap();
    }
    let query_emb = random_vec(384);
    let scope = MemoryScope::default();
    c.bench_function("episodic/search_vector", |b| {
        b.iter(|| {
            black_box(
                store
                    .engram_search_episodic_vector(black_box(&query_emb), model, &scope, 10, 0.3)
                    .unwrap(),
            )
        });
    });
}

// ── Semantic memory CRUD ─────────────────────────────────────────────────

fn bench_semantic_store(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("semantic/store", |b| {
        b.iter(|| {
            let i = SEM_CTR.fetch_add(1, Ordering::Relaxed);
            let mem = SemanticMemory {
                id: format!("sem-{}", i),
                subject: "Kubernetes".into(),
                predicate: "uses".into(),
                object: "container orchestration".into(),
                full_text: MEMORY_CORPUS[(i as usize) % MEMORY_CORPUS.len()].into(),
                category: "technology".into(),
                scope: MemoryScope::default(),
                created_at: now(),
                ..Default::default()
            };
            store.engram_store_semantic(black_box(&mem)).unwrap();
        });
    });
}

fn bench_semantic_search_bm25(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        let mem = SemanticMemory {
            id: format!("ssb-{}", i),
            subject: "tech".into(),
            predicate: "uses".into(),
            object: content
                .split_whitespace()
                .next()
                .unwrap_or("unknown")
                .into(),
            full_text: (*content).into(),
            category: "fact".into(),
            scope: MemoryScope::default(),
            created_at: now(),
            ..Default::default()
        };
        store.engram_store_semantic(&mem).unwrap();
    }
    let scope = MemoryScope::default();
    c.bench_function("semantic/search_bm25", |b| {
        b.iter(|| {
            black_box(
                store
                    .engram_search_semantic_bm25(black_box("kubernetes deployment"), &scope, 10)
                    .unwrap(),
            )
        });
    });
}

// ── Spreading activation ─────────────────────────────────────────────────

fn bench_spreading_activation(c: &mut Criterion) {
    let store = fresh_store();
    for (i, content) in MEMORY_CORPUS.iter().enumerate() {
        store
            .store_memory(&format!("sa-{}", i), content, "fact", 5, None, None)
            .unwrap();
    }
    // Create edges forming a connected graph
    for i in 0..MEMORY_CORPUS.len() - 1 {
        engram::relate(
            &store,
            &format!("sa-{}", i),
            &format!("sa-{}", i + 1),
            EdgeType::RelatedTo,
            0.8,
        )
        .unwrap();
        // Add some cross-edges
        if i + 3 < MEMORY_CORPUS.len() {
            engram::relate(
                &store,
                &format!("sa-{}", i),
                &format!("sa-{}", i + 3),
                EdgeType::SupportedBy,
                0.5,
            )
            .unwrap();
        }
    }
    let seeds = vec!["sa-0".into(), "sa-5".into()];
    c.bench_function("graph/spreading_activation", |b| {
        b.iter(|| {
            black_box(
                store
                    .engram_spreading_activation(black_box(&seeds), 0.3)
                    .unwrap(),
            )
        });
    });
}

// ── Community detection ──────────────────────────────────────────────────

fn bench_community_detection(c: &mut Criterion) {
    let store = fresh_store();
    // Create a graph with clear communities (2 clusters of 10 memories)
    for i in 0..20 {
        store
            .store_memory(
                &format!("cd-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
                "fact",
                5,
                None,
                None,
            )
            .unwrap();
    }
    // Cluster A: 0-9 densely connected
    for i in 0..10 {
        for j in (i + 1)..10 {
            engram::relate(
                &store,
                &format!("cd-{}", i),
                &format!("cd-{}", j),
                EdgeType::RelatedTo,
                0.7,
            )
            .unwrap();
        }
    }
    // Cluster B: 10-19 densely connected
    for i in 10..20 {
        for j in (i + 1)..20 {
            engram::relate(
                &store,
                &format!("cd-{}", i),
                &format!("cd-{}", j),
                EdgeType::RelatedTo,
                0.6,
            )
            .unwrap();
        }
    }
    // Weak bridge between clusters
    engram::relate(&store, "cd-5", "cd-15", EdgeType::RelatedTo, 0.2).unwrap();

    c.bench_function("graph/community_detection", |b| {
        b.iter(|| black_box(engram::community_detection::detect_communities(&store).unwrap()));
    });
}

// ── Fact extraction heuristic ────────────────────────────────────────────

fn bench_extract_facts(c: &mut Criterion) {
    let user_msgs = &[
        ("preference", "I prefer dark mode and use Vim keybindings. My name is Alex."),
        ("context", "Our stack uses Kubernetes on AWS with PostgreSQL. The codebase is Rust + TypeScript."),
        ("instruction", "Always use snake_case for variable names. Never commit directly to main. Remember to run tests."),
    ];
    let assistant_response = "I've noted your preferences. I found that the Kubernetes cluster is running in us-east-1 with auto-scaling enabled. The solution is to use Helm charts for deployment management.";

    let mut group = c.benchmark_group("memory/extract_facts");
    for (label, user_msg) in user_msgs {
        group.bench_with_input(BenchmarkId::new("type", *label), user_msg, |b, user_msg| {
            b.iter(|| {
                black_box(memory::extract_memorable_facts_heuristic(
                    black_box(user_msg),
                    black_box(assistant_response),
                ))
            });
        });
    }
    group.finish();
}

// ── GC candidates listing ────────────────────────────────────────────────

fn bench_gc_candidates(c: &mut Criterion) {
    let mut group = c.benchmark_group("episodic/gc_candidates");
    for &count in &[50, 200, 1000] {
        let store = fresh_store();
        for i in 0..count {
            let mut mem = make_episodic(
                &format!("gcc-{}", i),
                MEMORY_CORPUS[i % MEMORY_CORPUS.len()],
            );
            mem.importance = (i % 10) as f32 * 0.1;
            store.engram_store_episodic(&mem).unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| black_box(store.engram_list_gc_candidates(black_box(3), 50).unwrap()));
        });
    }
    group.finish();
}

criterion_group!(
    store_ops,
    bench_store_memory,
    bench_search_keyword,
    bench_search_bm25,
    bench_list_memories,
    bench_memory_stats,
);
criterion_group!(
    graph_ops,
    bench_graph_relate,
    bench_graph_decay,
    bench_graph_gc,
    bench_graph_stats,
    bench_store_procedural,
);
criterion_group!(
    episodic_ops,
    bench_episodic_store,
    bench_episodic_get,
    bench_episodic_batch_get,
    bench_episodic_search_bm25,
    bench_episodic_search_vector,
);
criterion_group!(
    semantic_ops,
    bench_semantic_store,
    bench_semantic_search_bm25,
);
criterion_group!(
    advanced_ops,
    bench_spreading_activation,
    bench_community_detection,
    bench_extract_facts,
    bench_gc_candidates,
);
criterion_main!(
    store_ops,
    graph_ops,
    episodic_ops,
    semantic_ops,
    advanced_ops
);
