use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use openpawz_bench::*;
use openpawz_core::engine::audit::{self, AuditCategory};
use openpawz_core::engine::scc;
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};

static AUDIT_CTR: AtomicU64 = AtomicU64::new(0);

// ── Audit append ─────────────────────────────────────────────────────────

fn bench_audit_append(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("audit/append", |b| {
        b.iter(|| {
            let i = AUDIT_CTR.fetch_add(1, Ordering::Relaxed);
            audit::append(
                &store,
                AuditCategory::Cognitive,
                "bench-action",
                "bench-agent",
                "sess-1",
                &format!("subject-{}", i),
                Some("benchmark details"),
                true,
            )
            .unwrap();
        });
    });
}

// ── Audit verify chain ──────────────────────────────────────────────────

fn bench_audit_verify_chain(c: &mut Criterion) {
    let mut group = c.benchmark_group("audit/verify_chain");
    for &count in &[100, 1000, 5000] {
        let store = fresh_store();
        for i in 0..count {
            audit::append(
                &store,
                AuditCategory::ToolCall,
                "action",
                "agent",
                "sess",
                &format!("sub-{}", i),
                None,
                true,
            )
            .unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| black_box(audit::verify_chain(store).unwrap()));
        });
    }
    group.finish();
}

// ── Audit query recent ──────────────────────────────────────────────────

fn bench_audit_query_recent(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..500 {
        audit::append(
            &store,
            AuditCategory::Memory,
            "search",
            "agent",
            "sess",
            &format!("q-{}", i),
            None,
            true,
        )
        .unwrap();
    }
    c.bench_function("audit/query_recent_50", |b| {
        b.iter(|| black_box(audit::query_recent(&store, 50, None, None).unwrap()));
    });
}

// ── Audit stats ─────────────────────────────────────────────────────────

fn bench_audit_stats(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..200 {
        audit::append(
            &store,
            if i % 3 == 0 {
                AuditCategory::ToolCall
            } else {
                AuditCategory::Memory
            },
            "act",
            "agent",
            "sess",
            &format!("s-{}", i),
            None,
            true,
        )
        .unwrap();
    }
    c.bench_function("audit/stats", |b| {
        b.iter(|| black_box(audit::stats(&store).unwrap()));
    });
}

// ── SCC issue certificate ───────────────────────────────────────────────

fn bench_scc_issue(c: &mut Criterion) {
    let store = fresh_store();
    let capabilities = vec![
        "execute_command".into(),
        "read_file".into(),
        "write_file".into(),
    ];
    c.bench_function("scc/issue_certificate", |b| {
        b.iter(|| {
            black_box(scc::issue_certificate(&store, "gpt-4o", black_box(&capabilities)).unwrap());
        });
    });
}

// ── SCC verify chain ────────────────────────────────────────────────────

fn bench_scc_verify_chain(c: &mut Criterion) {
    let mut group = c.benchmark_group("scc/verify_chain");
    let caps = vec!["tool_a".into(), "tool_b".into()];
    for &count in &[10, 50, 200] {
        let store = fresh_store();
        for _ in 0..count {
            scc::issue_certificate(&store, "model", &caps).unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| black_box(scc::verify_chain(store).unwrap()));
        });
    }
    group.finish();
}

criterion_group!(
    audit_group,
    bench_audit_append,
    bench_audit_verify_chain,
    bench_audit_query_recent,
    bench_audit_stats
);
criterion_group!(scc_group, bench_scc_issue, bench_scc_verify_chain);
criterion_main!(audit_group, scc_group);
