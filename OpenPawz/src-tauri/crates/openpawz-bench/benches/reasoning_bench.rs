use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use openpawz_core::engine::engram::{
    affect_congruent_boost, affect_to_emotional_context, modulated_encoding_strength, score_affect,
};
use openpawz_core::engine::pricing;
use openpawz_core::engine::tool_metadata;
use std::hint::black_box;

// ── Emotional / Affective reasoning ──────────────────────────────────────

fn bench_score_affect_varied(c: &mut Criterion) {
    let texts = &[
        (
            "positive",
            "I'm absolutely thrilled that the deployment went flawlessly!",
        ),
        (
            "negative",
            "This is terrible, everything crashed and we lost customer data.",
        ),
        (
            "neutral",
            "The function returns an integer representing the count of items.",
        ),
        (
            "mixed",
            "Despite the initial panic, the team pulled together and recovered gracefully.",
        ),
    ];
    let mut group = c.benchmark_group("affect/score");
    for (label, text) in texts {
        group.bench_with_input(BenchmarkId::new("sentiment", *label), text, |b, text| {
            b.iter(|| black_box(score_affect(black_box(text))));
        });
    }
    group.finish();
}

fn bench_modulated_encoding_strength(c: &mut Criterion) {
    let affect = score_affect("The server is on fire but we're handling it.");
    c.bench_function("affect/modulated_encoding", |b| {
        b.iter(|| {
            black_box(modulated_encoding_strength(
                black_box(0.5),
                black_box(&affect),
            ))
        });
    });
}

fn bench_affect_congruent_boost(c: &mut Criterion) {
    let text_a = "I'm excited about the progress we've made on the feature.";
    let text_b = "The excitement around this release is palpable.";
    let score_a = score_affect(text_a);
    let score_b = score_affect(text_b);
    let ctx_a = affect_to_emotional_context(&score_a, text_a);
    let ctx_b = affect_to_emotional_context(&score_b, text_b);
    c.bench_function("affect/congruent_boost", |b| {
        b.iter(|| black_box(affect_congruent_boost(black_box(&ctx_a), black_box(&ctx_b))));
    });
}

fn bench_affect_to_emotional_context(c: &mut Criterion) {
    let text = "After hours of debugging, finally found the race condition in the mutex handling.";
    let score = score_affect(text);
    c.bench_function("affect/to_emotional_context", |b| {
        b.iter(|| {
            black_box(affect_to_emotional_context(
                black_box(&score),
                black_box(text),
            ))
        });
    });
}

// ── Pricing engine ───────────────────────────────────────────────────────

fn bench_model_price(c: &mut Criterion) {
    let models = &[
        "gpt-4o",
        "claude-sonnet-4-20250514",
        "gemini-2.0-flash",
        "deepseek-chat",
        "unknown-model-xyz",
    ];
    let mut group = c.benchmark_group("pricing/model_price");
    for model in models {
        group.bench_with_input(BenchmarkId::new("model", *model), model, |b, model| {
            b.iter(|| black_box(pricing::model_price(black_box(model))));
        });
    }
    group.finish();
}

fn bench_estimate_cost(c: &mut Criterion) {
    c.bench_function("pricing/estimate_cost_usd", |b| {
        b.iter(|| {
            black_box(pricing::estimate_cost_usd(
                black_box("gpt-4o"),
                black_box(2000),
                black_box(500),
                black_box(1500),
                black_box(0),
            ))
        });
    });
}

fn bench_classify_task_complexity(c: &mut Criterion) {
    let messages = &[
        ("simple", "What time is it?"),
        ("complex", "Analyze the trade-offs between microservices and monolithic architecture for a high-throughput financial trading platform with sub-millisecond latency requirements, considering CAP theorem implications and eventual consistency patterns."),
    ];
    let mut group = c.benchmark_group("pricing/classify_complexity");
    for (label, msg) in messages {
        group.bench_with_input(BenchmarkId::new("msg", *label), msg, |b, msg| {
            b.iter(|| black_box(pricing::classify_task_complexity(black_box(msg))));
        });
    }
    group.finish();
}

// ── Tool metadata ────────────────────────────────────────────────────────

fn bench_tool_metadata_get(c: &mut Criterion) {
    let tools = &[
        "execute_command",
        "read_file",
        "list_directory",
        "unknown_tool_xyz",
    ];
    let mut group = c.benchmark_group("tool_meta/get");
    for tool in tools {
        group.bench_with_input(BenchmarkId::new("tool", *tool), tool, |b, tool| {
            b.iter(|| black_box(tool_metadata::get(black_box(tool))));
        });
    }
    group.finish();
}

fn bench_tools_in_tier(c: &mut Criterion) {
    let tiers = &[
        ("safe", tool_metadata::ToolTier::Safe),
        ("reversible", tool_metadata::ToolTier::Reversible),
        ("external", tool_metadata::ToolTier::External),
    ];
    let mut group = c.benchmark_group("tool_meta/tools_in_tier");
    for (label, tier) in tiers {
        group.bench_with_input(BenchmarkId::new("tier", *label), tier, |b, tier| {
            b.iter(|| black_box(tool_metadata::tools_in_tier(*tier)));
        });
    }
    group.finish();
}

fn bench_tool_domain(c: &mut Criterion) {
    c.bench_function("tool_meta/domain_lookup", |b| {
        b.iter(|| {
            black_box(tool_metadata::domain(black_box("execute_command")));
            black_box(tool_metadata::domain(black_box("coinbase_get_balance")));
            black_box(tool_metadata::domain(black_box("read_file")));
        });
    });
}

criterion_group!(
    affect_group,
    bench_score_affect_varied,
    bench_modulated_encoding_strength,
    bench_affect_congruent_boost,
    bench_affect_to_emotional_context,
);
criterion_group!(
    pricing_group,
    bench_model_price,
    bench_estimate_cost,
    bench_classify_task_complexity,
);
criterion_group!(
    tool_meta_group,
    bench_tool_metadata_get,
    bench_tools_in_tier,
    bench_tool_domain,
);
criterion_main!(affect_group, pricing_group, tool_meta_group);
