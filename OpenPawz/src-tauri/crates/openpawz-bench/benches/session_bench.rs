use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use openpawz_bench::*;
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};

static SESSION_CTR: AtomicU64 = AtomicU64::new(0);
static MSG_CTR: AtomicU64 = AtomicU64::new(0);
static TASK_CTR: AtomicU64 = AtomicU64::new(0);
static AGENT_CTR: AtomicU64 = AtomicU64::new(0);

fn bench_session_create(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("session/create", |b| {
        b.iter(|| {
            let i = SESSION_CTR.fetch_add(1, Ordering::Relaxed);
            store
                .create_session(&format!("s-{}", i), "bench-model", None, None)
                .unwrap();
        });
    });
}

fn bench_session_list(c: &mut Criterion) {
    let mut group = c.benchmark_group("session/list");
    for &count in &[10, 100, 500] {
        let store = fresh_store();
        for i in 0..count {
            store
                .create_session(&format!("sl-{}", i), "model", None, None)
                .unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| black_box(store.list_sessions(black_box(count as i64)).unwrap().len()));
        });
    }
    group.finish();
}

fn bench_message_add(c: &mut Criterion) {
    let store = fresh_store();
    store
        .create_session("msg-bench", "model", None, None)
        .unwrap();
    c.bench_function("message/add", |b| {
        b.iter(|| {
            let i = MSG_CTR.fetch_add(1, Ordering::Relaxed);
            store
                .add_message(&make_message(
                    &format!("m-{}", i),
                    "msg-bench",
                    "user",
                    "What is the meaning of life?",
                ))
                .unwrap();
        });
    });
}

fn bench_message_get(c: &mut Criterion) {
    let mut group = c.benchmark_group("message/get");
    for &count in &[50, 200, 1000] {
        let store = fresh_store();
        store
            .create_session("get-bench", "model", None, None)
            .unwrap();
        for i in 0..count {
            store
                .add_message(&make_message(
                    &format!("mg-{}", i),
                    "get-bench",
                    if i % 2 == 0 { "user" } else { "assistant" },
                    &format!(
                        "Message {} with realistic content length to simulate actual usage.",
                        i
                    ),
                ))
                .unwrap();
        }
        group.bench_with_input(BenchmarkId::from_parameter(count), &store, |b, store| {
            b.iter(|| {
                black_box(
                    store
                        .get_messages(black_box("get-bench"), count as i64)
                        .unwrap()
                        .len(),
                )
            });
        });
    }
    group.finish();
}

fn bench_task_create(c: &mut Criterion) {
    let store = fresh_store();
    c.bench_function("task/create", |b| {
        b.iter(|| {
            let i = TASK_CTR.fetch_add(1, Ordering::Relaxed);
            store
                .create_task(black_box(&make_task(&format!("t-{}", i))))
                .unwrap();
        });
    });
}

fn bench_task_list(c: &mut Criterion) {
    let store = fresh_store();
    for i in 0..200 {
        store.create_task(&make_task(&format!("tl-{}", i))).unwrap();
    }
    c.bench_function("task/list_200", |b| {
        b.iter(|| black_box(store.list_tasks().unwrap().len()));
    });
}

fn bench_agent_file_set(c: &mut Criterion) {
    let store = fresh_store();
    let content = "# SOUL\n\nYou are a meticulous researcher who values accuracy above all.\
        \n\n## Principles\n\n- Always cite sources\n- Prefer depth over breadth\n- Flag uncertainty";
    c.bench_function("agent/file_set", |b| {
        b.iter(|| {
            let i = AGENT_CTR.fetch_add(1, Ordering::Relaxed);
            store
                .set_agent_file(&format!("ag-{}", i % 10), &format!("f-{}.md", i), content)
                .unwrap();
        });
    });
}

fn bench_agent_file_get(c: &mut Criterion) {
    let store = fresh_store();
    store
        .set_agent_file("read-agent", "SOUL.md", "You are a helpful assistant.")
        .unwrap();
    c.bench_function("agent/file_get", |b| {
        b.iter(|| {
            black_box(
                store
                    .get_agent_file(black_box("read-agent"), black_box("SOUL.md"))
                    .unwrap(),
            )
        });
    });
}

criterion_group!(sessions, bench_session_create, bench_session_list);
criterion_group!(messages, bench_message_add, bench_message_get);
criterion_group!(tasks, bench_task_create, bench_task_list);
criterion_group!(agents, bench_agent_file_set, bench_agent_file_get);
criterion_main!(sessions, messages, tasks, agents);
