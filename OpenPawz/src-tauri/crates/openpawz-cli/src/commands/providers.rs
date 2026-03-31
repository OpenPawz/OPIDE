use crate::OutputFormat;
use clap::Subcommand;
use openpawz_core::engine::provider_registry;

#[derive(Subcommand)]
pub enum ProvidersAction {
    /// List all registered integration providers
    List,
    /// Show only providers that are ready to use (non-placeholder credentials)
    Ready,
    /// Check status of a specific provider
    Check {
        /// Service ID (e.g. "github", "slack", "notion")
        service_id: String,
    },
    /// Show total provider count
    Count,
}

pub fn run(action: ProvidersAction, format: &OutputFormat) -> Result<(), String> {
    match action {
        ProvidersAction::List => {
            let ids = provider_registry::registered_service_ids();
            let total = provider_registry::total_providers();

            match format {
                OutputFormat::Json => {
                    let items: Vec<serde_json::Value> = ids
                        .iter()
                        .map(|id| {
                            serde_json::json!({
                                "service_id": id,
                                "display_name": provider_registry::display_name(id),
                                "ready": provider_registry::is_ready(id),
                                "has_provider": provider_registry::has_provider(id),
                                "has_registration": provider_registry::has_registration(id),
                            })
                        })
                        .collect();
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    for id in &ids {
                        let ready = if provider_registry::is_ready(id) {
                            "ready"
                        } else {
                            "pending"
                        };
                        println!("{}\t{}", id, ready);
                    }
                }
                OutputFormat::Human => {
                    let ready_count = ids
                        .iter()
                        .filter(|id| provider_registry::is_ready(id))
                        .count();
                    println!(
                        "\x1b[1m🔌 Integration Providers\x1b[0m — {}/{} ready ({} total in database)\n",
                        ready_count,
                        ids.len(),
                        total,
                    );
                    println!("{:<24} {:<30} {:>8}", "SERVICE", "NAME", "STATUS");
                    println!("{}", "-".repeat(66));
                    for id in &ids {
                        let name =
                            provider_registry::display_name(id).unwrap_or_else(|| "-".into());
                        let status = if provider_registry::is_ready(id) {
                            "\x1b[32m● ready\x1b[0m"
                        } else {
                            "\x1b[33m○ pending\x1b[0m"
                        };
                        println!("{:<24} {:<30} {}", id, truncate(&name, 28), status);
                    }
                }
            }
            Ok(())
        }
        ProvidersAction::Ready => {
            let ids = provider_registry::ready_service_ids();

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
                    if ids.is_empty() {
                        println!("No providers are ready. Run \x1b[1mopenpawz setup\x1b[0m to configure.");
                    } else {
                        println!("\x1b[1m✅ Ready providers:\x1b[0m\n");
                        for id in &ids {
                            let name =
                                provider_registry::display_name(id).unwrap_or_else(|| id.clone());
                            println!("  \x1b[32m●\x1b[0m {} ({})", name, id);
                        }
                    }
                }
            }
            Ok(())
        }
        ProvidersAction::Check { service_id } => {
            let has_provider = provider_registry::has_provider(&service_id);
            let has_reg = provider_registry::has_registration(&service_id);
            let is_ready = provider_registry::is_ready(&service_id);
            let name = provider_registry::display_name(&service_id);
            let base_url = provider_registry::get_base_url(&service_id);

            match format {
                OutputFormat::Json => {
                    let obj = serde_json::json!({
                        "service_id": service_id,
                        "display_name": name,
                        "has_provider": has_provider,
                        "has_registration": has_reg,
                        "is_ready": is_ready,
                        "base_url": base_url,
                    });
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?
                    );
                }
                OutputFormat::Quiet => {
                    println!("{}", if is_ready { "ready" } else { "not_ready" });
                }
                OutputFormat::Human => {
                    println!("\x1b[1mProvider: {}\x1b[0m\n", service_id);
                    if let Some(n) = &name {
                        println!("  Name:           {}", n);
                    }
                    println!(
                        "  Provider config: {}",
                        if has_provider {
                            "\x1b[32m✓\x1b[0m"
                        } else {
                            "\x1b[31m✗ not found\x1b[0m"
                        }
                    );
                    println!(
                        "  Registration:    {}",
                        if has_reg {
                            "\x1b[32m✓\x1b[0m"
                        } else {
                            "\x1b[31m✗ not registered\x1b[0m"
                        }
                    );
                    println!(
                        "  Ready:           {}",
                        if is_ready {
                            "\x1b[32m✓ credentials configured\x1b[0m"
                        } else {
                            "\x1b[33m○ pending setup\x1b[0m"
                        }
                    );
                    if let Some(url) = &base_url {
                        println!("  API URL:         {}", url);
                    }
                }
            }
            Ok(())
        }
        ProvidersAction::Count => {
            let total = provider_registry::total_providers();
            let registered = provider_registry::registered_service_ids().len();
            let ready = provider_registry::ready_service_ids().len();

            match format {
                OutputFormat::Json => {
                    println!(
                        r#"{{"total": {}, "registered": {}, "ready": {}}}"#,
                        total, registered, ready
                    );
                }
                _ => {
                    println!(
                        "{} total providers, {} registered, {} ready",
                        total, registered, ready
                    );
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
