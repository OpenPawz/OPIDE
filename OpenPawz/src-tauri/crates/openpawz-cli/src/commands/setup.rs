use openpawz_core::engine::sessions::SessionStore;
use std::io::{self, Write};

pub fn run(store: &SessionStore) -> Result<(), String> {
    println!("OpenPawz Setup");
    println!("{}", "=".repeat(40));
    println!();

    // Check if already configured
    if let Ok(Some(config)) = store.get_config("engine_config") {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&config) {
            if parsed
                .get("providers")
                .and_then(|p| p.as_array())
                .is_some_and(|a| !a.is_empty())
            {
                println!("Engine is already configured with a provider.");
                print!("Reconfigure? [y/N] ");
                io::stdout().flush().ok();
                let mut input = String::new();
                io::stdin()
                    .read_line(&mut input)
                    .map_err(|e| e.to_string())?;
                if !input.trim().eq_ignore_ascii_case("y") {
                    println!("Setup cancelled.");
                    return Ok(());
                }
            }
        }
    }

    // Choose provider
    println!("Select AI provider:");
    println!("  1. Anthropic (Claude)");
    println!("  2. OpenAI (GPT)");
    println!("  3. Google (Gemini)");
    println!("  4. Ollama (Local)");
    println!("  5. OpenRouter");
    println!();
    print!("Choice [1]: ");
    io::stdout().flush().ok();
    let mut choice = String::new();
    io::stdin()
        .read_line(&mut choice)
        .map_err(|e| e.to_string())?;
    let choice = choice.trim();
    let choice = if choice.is_empty() { "1" } else { choice };

    let (provider_id, provider_kind, default_model, needs_key) = match choice {
        "1" => ("anthropic", "Anthropic", "claude-sonnet-4-20250514", true),
        "2" => ("openai", "OpenAI", "gpt-5.1", true),
        "3" => ("google", "Google", "gemini-2.0-flash", true),
        "4" => ("ollama", "Ollama", "llama3.2", false),
        "5" => (
            "openrouter",
            "OpenRouter",
            "anthropic/claude-sonnet-4-20250514",
            true,
        ),
        _ => {
            return Err(format!("Invalid choice: {}", choice));
        }
    };

    let api_key = if needs_key {
        print!("API key for {}: ", provider_kind);
        io::stdout().flush().ok();
        let mut key = String::new();
        io::stdin().read_line(&mut key).map_err(|e| e.to_string())?;
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err("API key cannot be empty.".into());
        }
        key
    } else {
        String::new()
    };

    // Build config JSON
    let config = serde_json::json!({
        "default_provider": provider_id,
        "default_model": default_model,
        "providers": [{
            "id": provider_id,
            "kind": provider_kind,
            "api_key": api_key,
            "default_model": default_model,
        }],
        "max_tool_rounds": 10,
        "daily_budget_usd": 5.0,
        "tool_timeout_secs": 30,
        "max_concurrent_runs": 4,
    });

    store
        .set_config("engine_config", &config.to_string())
        .map_err(|e| e.to_string())?;

    println!();
    println!("Setup complete!");
    println!("  Provider: {} ({})", provider_kind, provider_id);
    println!("  Model:    {}", default_model);
    println!();
    println!("Try: openpawz status");

    Ok(())
}
