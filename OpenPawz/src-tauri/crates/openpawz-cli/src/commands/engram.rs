use crate::OutputFormat;
use clap::Subcommand;
use openpawz_core::atoms::engram_types::MemoryScope;
use openpawz_core::engine::engram;
use openpawz_core::engine::sessions::SessionStore;

#[derive(Subcommand)]
pub enum EngramAction {
    /// Search episodic memories (BM25 full-text)
    Search {
        /// Search query
        query: String,
        /// Max results
        #[arg(long, default_value = "10")]
        limit: usize,
        /// Filter by agent ID
        #[arg(long)]
        agent: Option<String>,
    },
    /// Search semantic memories (subject-predicate-object triples)
    Semantic {
        /// Search query
        query: String,
        /// Max results
        #[arg(long, default_value = "10")]
        limit: usize,
    },
    /// Search procedural memories (learned tool-use patterns)
    Procedural {
        /// Search query
        query: String,
        /// Max results
        #[arg(long, default_value = "10")]
        limit: usize,
    },
    /// Show memory graph statistics (total memories, edges, communities)
    Stats,
    /// List edges from a memory node (graph exploration)
    Edges {
        /// Memory ID to show edges for
        id: String,
    },
    /// Run spreading activation from seed memory IDs
    Activate {
        /// Seed memory IDs (comma-separated)
        seeds: String,
        /// Minimum edge weight threshold
        #[arg(long, default_value = "0.3")]
        min_weight: f32,
    },
    /// List episodic memories eligible for garbage collection
    GcCandidates {
        /// Importance threshold (memories at or below this are candidates)
        #[arg(long, default_value = "2")]
        threshold: i32,
        /// Max candidates to list
        #[arg(long, default_value = "20")]
        limit: usize,
    },
}

pub fn run(
    store: &SessionStore,
    action: EngramAction,
    format: &OutputFormat,
) -> Result<(), String> {
    match action {
        EngramAction::Search {
            query,
            limit,
            agent,
        } => {
            let scope = MemoryScope {
                agent_id: agent,
                ..Default::default()
            };
            let results = store
                .engram_search_episodic_bm25(&query, &scope, limit)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    let items: Vec<serde_json::Value> = results
                        .iter()
                        .map(|(mem, score)| {
                            serde_json::json!({
                                "id": mem.id,
                                "content": mem.content.full,
                                "category": mem.category,
                                "importance": mem.importance,
                                "agent_id": mem.agent_id,
                                "score": score,
                                "created_at": mem.created_at,
                            })
                        })
                        .collect();
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for (mem, score) in &results {
                        println!("{}\t{:.3}", mem.id, score);
                    }
                }
                OutputFormat::Human => {
                    if results.is_empty() {
                        println!("No episodic memories match '{}'.", query);
                    } else {
                        println!(
                            "\x1b[1m🧠 Episodic search: \"{}\"\x1b[0m — {} result(s)\n",
                            query,
                            results.len()
                        );
                        for (i, (mem, score)) in results.iter().enumerate() {
                            let content_preview = truncate(&mem.content.full, 80);
                            println!(
                                "  \x1b[1m{}.\x1b[0m [score={:.3}] \x1b[36m{}\x1b[0m",
                                i + 1,
                                score,
                                mem.id
                            );
                            println!("     {}", content_preview);
                            println!(
                                "     \x1b[2m{} | imp={:.1} | agent={}\x1b[0m",
                                mem.category, mem.importance, mem.agent_id
                            );
                            println!();
                        }
                    }
                }
            }
            Ok(())
        }
        EngramAction::Semantic { query, limit } => {
            let scope = MemoryScope::default();
            let results = store
                .engram_search_semantic_bm25(&query, &scope, limit)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    let items: Vec<serde_json::Value> = results
                        .iter()
                        .map(|(mem, score)| {
                            serde_json::json!({
                                "id": mem.id,
                                "subject": mem.subject,
                                "predicate": mem.predicate,
                                "object": mem.object,
                                "full_text": mem.full_text,
                                "confidence": mem.confidence,
                                "score": score,
                            })
                        })
                        .collect();
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for (mem, score) in &results {
                        println!("{}\t{:.3}", mem.id, score);
                    }
                }
                OutputFormat::Human => {
                    if results.is_empty() {
                        println!("No semantic memories match '{}'.", query);
                    } else {
                        println!(
                            "\x1b[1m📚 Semantic search: \"{}\"\x1b[0m — {} result(s)\n",
                            query,
                            results.len()
                        );
                        for (i, (mem, score)) in results.iter().enumerate() {
                            println!(
                                "  \x1b[1m{}.\x1b[0m [score={:.3}] {} \x1b[33m{}\x1b[0m {}",
                                i + 1,
                                score,
                                mem.subject,
                                mem.predicate,
                                mem.object
                            );
                            println!(
                                "     \x1b[2mconf={:.2} | v{} | {}\x1b[0m",
                                mem.confidence, mem.version, mem.id
                            );
                            println!();
                        }
                    }
                }
            }
            Ok(())
        }
        EngramAction::Procedural { query, limit } => {
            let scope = MemoryScope::default();
            let results = store
                .engram_search_procedural(&query, &scope, limit)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    let items: Vec<serde_json::Value> = results
                        .iter()
                        .map(|mem| {
                            serde_json::json!({
                                "id": mem.id,
                                "trigger": mem.trigger,
                                "steps": mem.steps.len(),
                                "success_rate": mem.success_rate,
                                "execution_count": mem.execution_count,
                            })
                        })
                        .collect();
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for mem in &results {
                        println!("{}", mem.id);
                    }
                }
                OutputFormat::Human => {
                    if results.is_empty() {
                        println!("No procedural memories match '{}'.", query);
                    } else {
                        println!(
                            "\x1b[1m⚙️  Procedural search: \"{}\"\x1b[0m — {} result(s)\n",
                            query,
                            results.len()
                        );
                        for (i, mem) in results.iter().enumerate() {
                            println!("  \x1b[1m{}.\x1b[0m \x1b[36m{}\x1b[0m", i + 1, mem.trigger,);
                            println!(
                                "     {} steps | {:.0}% success | {} runs",
                                mem.steps.len(),
                                mem.success_rate * 100.0,
                                mem.execution_count,
                            );
                            for (j, step) in mem.steps.iter().enumerate() {
                                let tool = step.tool_name.as_deref().unwrap_or("-");
                                println!(
                                    "     \x1b[2m  {}. {} ({})\x1b[0m",
                                    j + 1,
                                    step.description,
                                    tool
                                );
                            }
                            println!();
                        }
                    }
                }
            }
            Ok(())
        }
        EngramAction::Stats => {
            let stats = engram::memory_stats(store).map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&stats).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    println!(
                        "episodic={} semantic={} procedural={} edges={}",
                        stats.episodic, stats.semantic, stats.procedural, stats.edges
                    );
                }
                OutputFormat::Human => {
                    println!("\x1b[1m🧠 Engram Memory Statistics\x1b[0m\n");
                    println!("  Episodic:          {}", stats.episodic);
                    println!("  Semantic:          {}", stats.semantic);
                    println!("  Procedural:        {}", stats.procedural);
                    println!("  Graph edges:       {}", stats.edges);
                    println!("  ────────────────────");
                    println!(
                        "  Total memories:    {}",
                        stats.episodic + stats.semantic + stats.procedural
                    );
                }
            }
            Ok(())
        }
        EngramAction::Edges { id } => {
            let from = store
                .engram_get_edges_from(&id)
                .map_err(|e| e.to_string())?;
            let to = store.engram_get_edges_to(&id).map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    let obj = serde_json::json!({
                        "id": id,
                        "outgoing": from.iter().map(|e| serde_json::json!({
                            "target": e.target_id,
                            "edge_type": format!("{:?}", e.edge_type),
                            "weight": e.weight,
                        })).collect::<Vec<_>>(),
                        "incoming": to.iter().map(|e| serde_json::json!({
                            "source": e.source_id,
                            "edge_type": format!("{:?}", e.edge_type),
                            "weight": e.weight,
                        })).collect::<Vec<_>>(),
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for e in &from {
                        println!("out\t{}\t{:?}\t{:.2}", e.target_id, e.edge_type, e.weight);
                    }
                    for e in &to {
                        println!("in\t{}\t{:?}\t{:.2}", e.source_id, e.edge_type, e.weight);
                    }
                }
                OutputFormat::Human => {
                    println!("\x1b[1mEdges for {}\x1b[0m\n", id);
                    if from.is_empty() && to.is_empty() {
                        println!("  No edges found.");
                    } else {
                        if !from.is_empty() {
                            println!("  \x1b[1mOutgoing ({}):\x1b[0m", from.len());
                            for e in &from {
                                println!(
                                    "    → {} \x1b[2m({:?}, w={:.2})\x1b[0m",
                                    e.target_id, e.edge_type, e.weight
                                );
                            }
                        }
                        if !to.is_empty() {
                            println!("  \x1b[1mIncoming ({}):\x1b[0m", to.len());
                            for e in &to {
                                println!(
                                    "    ← {} \x1b[2m({:?}, w={:.2})\x1b[0m",
                                    e.source_id, e.edge_type, e.weight
                                );
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        EngramAction::Activate { seeds, min_weight } => {
            let seed_ids: Vec<String> = seeds.split(',').map(|s| s.trim().to_string()).collect();
            let activated = store
                .engram_spreading_activation(&seed_ids, min_weight)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    let items: Vec<serde_json::Value> = activated
                        .iter()
                        .map(|(id, weight)| serde_json::json!({"id": id, "activation": weight}))
                        .collect();
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for (id, w) in &activated {
                        println!("{}\t{:.3}", id, w);
                    }
                }
                OutputFormat::Human => {
                    println!(
                        "\x1b[1m⚡ Spreading activation\x1b[0m — seeds: {}, min_weight: {}\n",
                        seed_ids.join(", "),
                        min_weight
                    );
                    if activated.is_empty() {
                        println!("  No memories activated (graph may be empty).");
                    } else {
                        for (i, (id, w)) in activated.iter().enumerate() {
                            let bar_len = (w * 20.0) as usize;
                            let bar: String = "█".repeat(bar_len.min(20));
                            println!("  {:>3}. {:<40} {:.3} {}", i + 1, truncate(id, 38), w, bar,);
                        }
                    }
                }
            }
            Ok(())
        }
        EngramAction::GcCandidates { threshold, limit } => {
            let ids = store
                .engram_list_gc_candidates(threshold, limit)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&ids).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for id in &ids {
                        println!("{}", id);
                    }
                }
                OutputFormat::Human => {
                    println!(
                        "\x1b[1m🗑 GC candidates\x1b[0m (importance ≤ {}, limit {})\n",
                        threshold, limit
                    );
                    if ids.is_empty() {
                        println!("  No candidates found.");
                    } else {
                        for id in &ids {
                            println!("  • {}", id);
                        }
                        println!(
                            "\n  {} memor(ies) eligible for garbage collection.",
                            ids.len()
                        );
                    }
                }
            }
            Ok(())
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
    }
}
