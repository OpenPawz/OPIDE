//! Shared test fixtures and helpers for the OpenPawz benchmark suite.
//!
//! Run all benchmarks:
//!   cargo bench -p openpawz-bench
//!
//! Run a specific suite:
//!   cargo bench -p openpawz-bench --bench memory_bench
//!
//! Filter to a specific group:
//!   cargo bench -p openpawz-bench --bench engram_bench -- hnsw

use openpawz_core::engine::sessions::SessionStore;

/// Create a fresh in-memory SessionStore with full schema for benchmarks.
pub fn fresh_store() -> SessionStore {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    openpawz_core::engine::sessions::schema_for_testing(&conn);
    SessionStore::from_connection(conn)
}

/// Current timestamp as RFC3339 string.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Build a StoredMessage for benchmarks.
pub fn make_message(
    id: &str,
    session_id: &str,
    role: &str,
    content: &str,
) -> openpawz_core::atoms::types::StoredMessage {
    openpawz_core::atoms::types::StoredMessage {
        id: id.into(),
        session_id: session_id.into(),
        role: role.into(),
        content: content.into(),
        tool_calls_json: None,
        tool_call_id: None,
        name: None,
        created_at: now(),
    }
}

/// Build a Task for benchmarks.
pub fn make_task(id: &str) -> openpawz_core::atoms::types::Task {
    let ts = now();
    openpawz_core::atoms::types::Task {
        id: id.into(),
        title: "Benchmark task".into(),
        description: "Created during benchmarking".into(),
        status: "inbox".into(),
        priority: "medium".into(),
        assigned_agent: None,
        assigned_agents: vec![],
        session_id: None,
        model: None,
        cron_schedule: None,
        cron_enabled: false,
        last_run_at: None,
        next_run_at: None,
        created_at: ts.clone(),
        updated_at: ts,
        event_trigger: None,
        persistent: false,
    }
}

/// Build a RetrievedMemory for reranking / abstraction benchmarks.
pub fn make_retrieved_memory(
    id: &str,
    content: &str,
    relevance: f32,
) -> openpawz_core::atoms::engram_types::RetrievedMemory {
    openpawz_core::atoms::engram_types::RetrievedMemory {
        content: content.into(),
        compression_level: openpawz_core::atoms::engram_types::CompressionLevel::Full,
        memory_id: id.into(),
        memory_type: openpawz_core::atoms::engram_types::MemoryType::Episodic,
        trust_score: openpawz_core::atoms::engram_types::TrustScore {
            relevance,
            accuracy: 0.7,
            freshness: 0.6,
            utility: 0.5,
        },
        token_cost: content.len() / 4,
        category: "fact".into(),
        created_at: now(),
        agent_id: "bench-agent".into(),
    }
}

/// Generate a random f32 vector of given dimensions.
pub fn random_vec(dims: usize) -> Vec<f32> {
    // Simple PRNG for reproducible benchmarks — not crypto-quality.
    use std::cell::Cell;
    thread_local! {
        static SEED: Cell<u64> = const { Cell::new(0xBEEF_CAFE_DEAD_F00D) };
    }
    (0..dims)
        .map(|_| {
            SEED.with(|s| {
                let mut x = s.get();
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                s.set(x);
                (x as f32 / u64::MAX as f32) - 0.5
            })
        })
        .collect()
}

/// Corpus of realistic memory content for search benchmarks.
pub const MEMORY_CORPUS: &[&str] = &[
    "deployment target AWS us-east-1 with auto-scaling enabled",
    "user prefers dark mode interface with high contrast",
    "project uses Rust with Tauri framework for desktop app",
    "database migration strategy PostgreSQL to CockroachDB",
    "CI/CD pipeline GitHub Actions with parallel jobs",
    "API rate limiting using Redis sliding window algorithm",
    "frontend React TypeScript with Jotai state management",
    "security audit OWASP top 10 compliance review pending",
    "monitoring Prometheus Grafana with custom dashboards",
    "backup strategy S3 lifecycle policies every 6 hours",
    "authentication OAuth2 PKCE flow with refresh tokens",
    "caching layer Cloudflare Workers with stale-while-revalidate",
    "error handling structured logging with correlation IDs",
    "feature flags LaunchDarkly with percentage rollouts",
    "load testing k6 scripts targeting 10K concurrent users",
    "DNS configuration Route53 with health check failover",
    "container orchestration Kubernetes with Helm charts",
    "secret management Vault with auto-rotation policies",
    "observability OpenTelemetry traces and metrics",
    "incident response PagerDuty escalation policies",
];
