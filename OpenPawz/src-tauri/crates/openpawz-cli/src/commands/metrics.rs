use crate::OutputFormat;
use clap::Subcommand;
use openpawz_core::engine::sessions::SessionStore;

#[derive(Subcommand)]
pub enum MetricsAction {
    /// Show today's usage summary (tokens, cost, tool calls)
    Today,
    /// Show usage for a specific date (YYYY-MM-DD)
    Daily {
        /// Date to query (YYYY-MM-DD)
        date: String,
    },
    /// Show usage for a date range
    Range {
        /// Start date (YYYY-MM-DD)
        start: String,
        /// End date (YYYY-MM-DD)
        end: String,
    },
    /// Show per-model cost breakdown for today (or a given date)
    Models {
        /// Date to query (default: today)
        #[arg(long)]
        date: Option<String>,
    },
    /// Show metrics for a specific session
    Session {
        /// Session ID
        id: String,
    },
    /// Delete metrics older than a cutoff date
    Purge {
        /// Delete entries before this date (YYYY-MM-DD)
        before: String,
    },
}

pub fn run(
    store: &SessionStore,
    action: MetricsAction,
    format: &OutputFormat,
) -> Result<(), String> {
    match action {
        MetricsAction::Today => {
            let date = chrono::Local::now().format("%Y-%m-%d").to_string();
            show_daily(store, &date, format)
        }
        MetricsAction::Daily { date } => show_daily(store, &date, format),
        MetricsAction::Range { start, end } => {
            let summaries = store
                .get_metrics_range(&start, &end)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summaries).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for s in &summaries {
                        println!(
                            "{}\t{}\t${:.4}",
                            s.date,
                            s.input_tokens + s.output_tokens,
                            s.cost_usd
                        );
                    }
                }
                OutputFormat::Human => {
                    if summaries.is_empty() {
                        println!("No metrics found for {} to {}.", start, end);
                    } else {
                        println!(
                            "{:<12} {:>12} {:>12} {:>10} {:>8} {:>8}",
                            "DATE", "IN_TOKENS", "OUT_TOKENS", "COST", "TOOLS", "ROUNDS"
                        );
                        println!("{}", "-".repeat(72));
                        let mut total_cost = 0.0;
                        let mut total_tokens = 0u64;
                        for s in &summaries {
                            total_cost += s.cost_usd;
                            total_tokens += s.input_tokens + s.output_tokens;
                            println!(
                                "{:<12} {:>12} {:>12} {:>10} {:>8} {:>8}",
                                s.date,
                                fmt_num(s.input_tokens),
                                fmt_num(s.output_tokens),
                                format!("${:.4}", s.cost_usd),
                                s.tool_calls,
                                s.rounds,
                            );
                        }
                        println!("{}", "-".repeat(72));
                        println!(
                            "{:<12} {:>12} {:>24} {:>8}",
                            "TOTAL",
                            fmt_num(total_tokens),
                            format!("${:.4}", total_cost),
                            summaries.len(),
                        );
                    }
                }
            }
            Ok(())
        }
        MetricsAction::Models { date } => {
            let date = date.unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
            let breakdown = store
                .get_model_breakdown(&date)
                .map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&breakdown).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for m in &breakdown {
                        println!("{}\t${:.4}", m.model, m.cost_usd);
                    }
                }
                OutputFormat::Human => {
                    println!("\x1b[1mModel breakdown for {}\x1b[0m\n", date);
                    if breakdown.is_empty() {
                        println!("No model usage recorded for this date.");
                    } else {
                        println!(
                            "{:<30} {:>12} {:>12} {:>10} {:>6}",
                            "MODEL", "IN_TOKENS", "OUT_TOKENS", "COST", "TURNS"
                        );
                        println!("{}", "-".repeat(76));
                        for m in &breakdown {
                            println!(
                                "{:<30} {:>12} {:>12} {:>10} {:>6}",
                                truncate(&m.model, 28),
                                fmt_num(m.input_tokens),
                                fmt_num(m.output_tokens),
                                format!("${:.4}", m.cost_usd),
                                m.turn_count,
                            );
                        }
                    }
                }
            }
            Ok(())
        }
        MetricsAction::Session { id } => {
            let rows = store.list_session_metrics(&id).map_err(|e| e.to_string())?;

            match format {
                OutputFormat::Json => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for r in &rows {
                        println!(
                            "{}\t{}\t${:.4}",
                            r.model,
                            r.input_tokens + r.output_tokens,
                            r.cost_usd
                        );
                    }
                }
                OutputFormat::Human => {
                    if rows.is_empty() {
                        println!("No metrics found for session '{}'.", id);
                    } else {
                        let total_cost: f64 = rows.iter().map(|r| r.cost_usd).sum();
                        let total_tokens: u64 =
                            rows.iter().map(|r| r.input_tokens + r.output_tokens).sum();
                        println!(
                            "\x1b[1mSession {}\x1b[0m — {} turns, {} tokens, ${:.4}\n",
                            truncate(&id, 20),
                            rows.len(),
                            fmt_num(total_tokens),
                            total_cost
                        );
                        println!(
                            "{:<24} {:>10} {:>10} {:>8} {:>8}",
                            "MODEL", "IN", "OUT", "COST", "TOOLS"
                        );
                        println!("{}", "-".repeat(66));
                        for r in &rows {
                            println!(
                                "{:<24} {:>10} {:>10} {:>8} {:>8}",
                                truncate(&r.model, 22),
                                fmt_num(r.input_tokens),
                                fmt_num(r.output_tokens),
                                format!("${:.4}", r.cost_usd),
                                r.tool_calls,
                            );
                        }
                    }
                }
            }
            Ok(())
        }
        MetricsAction::Purge { before } => {
            let deleted = store
                .purge_metrics_before(&before)
                .map_err(|e| e.to_string())?;
            match format {
                OutputFormat::Json => {
                    println!(r#"{{"purged": {}, "before": "{}"}}"#, deleted, before);
                }
                _ => {
                    println!("Purged {} metric row(s) older than {}.", deleted, before);
                }
            }
            Ok(())
        }
    }
}

fn show_daily(store: &SessionStore, date: &str, format: &OutputFormat) -> Result<(), String> {
    let summary = store.get_daily_metrics(date).map_err(|e| e.to_string())?;

    match format {
        OutputFormat::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
            );
        }
        OutputFormat::Quiet => {
            println!(
                "{}\t${:.4}\t{}",
                date,
                summary.cost_usd,
                summary.input_tokens + summary.output_tokens
            );
        }
        OutputFormat::Human => {
            println!("\x1b[1m📊 Metrics for {}\x1b[0m\n", date);
            println!(
                "  Tokens (in/out):   {} / {}",
                fmt_num(summary.input_tokens),
                fmt_num(summary.output_tokens)
            );
            println!(
                "  Total cost:        \x1b[1m${:.4}\x1b[0m",
                summary.cost_usd
            );
            println!("  Tool calls:        {}", summary.tool_calls);
            println!("  Rounds:            {}", summary.rounds);
            println!("  Turns:             {}", summary.turn_count);
            if summary.llm_duration_ms > 0 {
                println!(
                    "  LLM time:          {:.1}s",
                    summary.llm_duration_ms as f64 / 1000.0
                );
                println!(
                    "  Tool time:         {:.1}s",
                    summary.tool_duration_ms as f64 / 1000.0
                );
                println!(
                    "  Total time:        {:.1}s",
                    summary.total_duration_ms as f64 / 1000.0
                );
            }
        }
    }
    Ok(())
}

fn fmt_num(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
    }
}
