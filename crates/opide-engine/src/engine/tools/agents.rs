// Paw Agent Engine — Agent management tools

use crate::atoms::error::EngineResult;
use crate::atoms::types::*;
use crate::engine::memory;
use crate::engine::state::EngineState;
use log::info;
use tauri::Emitter;
use tauri::Manager;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "self_info".into(),
                description: "Get information about yourself: your configuration, enabled skills, available tools, memory settings, and current context.".into(),
                parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "update_profile".into(),
                description: "Update your own profile: name, avatar, bio, or system prompt. Changes take effect immediately.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "agent_id": { "type": "string", "description": "Agent ID to update (use 'default' for the main agent)" },
                        "name": { "type": "string", "description": "New display name" },
                        "avatar": { "type": "string", "description": "New avatar URL or emoji" },
                        "bio": { "type": "string", "description": "Short bio / tagline" },
                        "system_prompt": { "type": "string", "description": "Updated system prompt / persona" }
                    },
                    "required": ["agent_id"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "create_agent".into(),
                description: "Create a new AI agent with a name, role, and system prompt. The agent will appear in the Agents view.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Name for the new agent" },
                        "role": { "type": "string", "description": "Agent's role (e.g. 'researcher', 'writer', 'coder')" },
                        "system_prompt": { "type": "string", "description": "Full system prompt / persona for the agent" },
                        "specialty": { "type": "string", "description": "Agent's specialty (e.g. 'crypto', 'marketing', 'general')" },
                        "model": { "type": "string", "description": "Model to use (optional, defaults to project default)" },
                        "capabilities": { "type": "array", "items": { "type": "string" }, "description": "List of tool names this agent can use (empty = all tools)" }
                    },
                    "required": ["name", "role", "system_prompt"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "agent_list".into(),
                description: "List all agents in the system with their roles, models, and skill counts. Only available to orchestrator/boss agents.".into(),
                parameters: serde_json::json!({ "type": "object", "properties": {}, "required": [] }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "manage_session".into(),
                description: "List, clear, or delete chat sessions. Use this to manage channel bridge sessions \
                    (Discord, Telegram, etc.) or any other session. Actions: 'list' shows sessions with message counts, \
                    'clear' wipes messages but keeps the session, 'delete' removes session entirely. \
                    Channel sessions have IDs like 'eng-discord-default-<user_id>'.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "clear", "delete"],
                            "description": "What to do: 'list' = show sessions, 'clear' = wipe messages (keep session), 'delete' = remove session + messages"
                        },
                        "session_id": {
                            "type": "string",
                            "description": "Session ID to clear/delete. Required for 'clear' and 'delete'. Supports prefix matching — e.g. 'eng-discord' matches all Discord sessions."
                        },
                        "filter": {
                            "type": "string",
                            "description": "Optional filter for 'list' — show only sessions whose ID contains this string (e.g. 'discord', 'telegram')"
                        }
                    },
                    "required": ["action"]
                }),
            },
        },
    ]
}

pub async fn execute(
    name: &str,
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
    _agent_id: &str,
) -> Option<Result<String, String>> {
    Some(match name {
        "self_info" => execute_self_info(app_handle)
            .await
            .map_err(|e| e.to_string()),
        "update_profile" => execute_update_profile(args, app_handle)
            .await
            .map_err(|e| e.to_string()),
        "create_agent" => execute_create_agent(args, app_handle)
            .await
            .map_err(|e| e.to_string()),
        "agent_list" => execute_agent_list(app_handle)
            .await
            .map_err(|e| e.to_string()),
        "manage_session" => execute_manage_session(args, app_handle)
            .await
            .map_err(|e| e.to_string()),
        _ => return None,
    })
}

async fn execute_self_info(app_handle: &tauri::AppHandle) -> EngineResult<String> {
    let state = app_handle
        .try_state::<EngineState>()
        .ok_or("Engine state not available")?;

    let cfg = state.config.lock();
    let mcfg = state.memory_config.lock();

    let providers_info: Vec<String> = cfg
        .providers
        .iter()
        .map(|p| {
            let is_default = cfg.default_provider.as_ref() == Some(&p.id);
            format!(
                "  - {} ({:?}){}",
                p.id,
                p.kind,
                if is_default { " <- DEFAULT" } else { "" }
            )
        })
        .collect();

    let routing = &cfg.model_routing;
    let routing_info = format!(
        "  Boss model: {}\n  Worker model: {}\n  Specialties: {}\n  Per-agent overrides: {}",
        routing.boss_model.as_deref().unwrap_or("(default)"),
        routing.worker_model.as_deref().unwrap_or("(default)"),
        if routing.specialty_models.is_empty() {
            "none".into()
        } else {
            routing
                .specialty_models
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join(", ")
        },
        if routing.agent_models.is_empty() {
            "none".into()
        } else {
            routing
                .agent_models
                .iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect::<Vec<_>>()
                .join(", ")
        },
    );

    let memory_info = format!(
        "  Embedding provider: {}\n  Embedding model: {}\n  Auto-recall: {}\n  Auto-capture: {}\n  Recall limit: {}",
        mcfg.embedding_base_url,
        if mcfg.embedding_model.is_empty() { "(not configured)" } else { &mcfg.embedding_model },
        mcfg.auto_recall,
        mcfg.auto_capture,
        mcfg.recall_limit,
    );

    // engine::skills was removed in OPIDE phase 1.
    let enabled_skills: Vec<String> = Vec::new();

    Ok(format!(
        "# Paw Engine Self-Info\n\n\
        ## Current Configuration\n\
        - Default model: {}\n\
        - Default provider: {}\n\
        - Max tool rounds: {}\n\
        - Tool timeout: {}s\n\n\
        ## Configured Providers\n{}\n\n\
        ## Model Routing (Orchestrator)\n{}\n\n\
        ## Memory Configuration\n{}\n\n\
        ## Enabled Skills\n{}\n\n\
        ## Data Location\n\
        - Config stored in: SQLite database (engine_config key)\n\
        - Soul files: stored in SQLite (agent_files table)\n\
        - Memories: stored in SQLite (memories table)\n\
        - Sessions: stored in SQLite (sessions + messages tables)",
        cfg.default_model.as_deref().unwrap_or("(not set)"),
        cfg.default_provider.as_deref().unwrap_or("(not set)"),
        cfg.max_tool_rounds,
        cfg.tool_timeout_secs,
        if providers_info.is_empty() {
            "  (none configured)".into()
        } else {
            providers_info.join("\n")
        },
        routing_info,
        memory_info,
        if enabled_skills.is_empty() {
            "  (none enabled)".into()
        } else {
            enabled_skills.join("\n")
        },
    ))
}

async fn execute_update_profile(
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> EngineResult<String> {
    let agent_id = args["agent_id"]
        .as_str()
        .ok_or("update_profile: missing 'agent_id' argument (use 'default' for the main agent)")?;

    let name = args["name"].as_str();
    let avatar = args["avatar"].as_str();
    let bio = args["bio"].as_str();
    let system_prompt = args["system_prompt"].as_str();

    if name.is_none() && avatar.is_none() && bio.is_none() && system_prompt.is_none() {
        return Err("update_profile: provide at least one field to update (name, avatar, bio, system_prompt)".into());
    }

    let mut updates = serde_json::Map::new();
    updates.insert("agent_id".into(), serde_json::json!(agent_id));
    if let Some(v) = name {
        updates.insert("name".into(), serde_json::json!(v));
    }
    if let Some(v) = avatar {
        updates.insert("avatar".into(), serde_json::json!(v));
    }
    if let Some(v) = bio {
        updates.insert("bio".into(), serde_json::json!(v));
    }
    if let Some(v) = system_prompt {
        updates.insert("system_prompt".into(), serde_json::json!(v));
    }

    info!(
        "[engine] update_profile tool: updating agent '{}' with fields: {:?}",
        agent_id,
        updates.keys().collect::<Vec<_>>()
    );

    let state = app_handle
        .try_state::<EngineState>()
        .ok_or("Engine state not available")?;

    // ── Persist the change ──────────────────────────────────────────────
    // `system_prompt` is a real column on project_agents, so it updates
    // there. The model has no name/avatar/bio columns, so those are stored
    // in a `profile.json` soul file (merged with any existing one) — the
    // agent can read it back via soul_read. Previously this tool emitted a
    // dead event + a memory note and PERSISTED NOTHING while telling the
    // caller "Successfully updated… UI updated in real-time" — a lie.
    let mut persisted: Vec<String> = Vec::new();

    if let Some(sp) = system_prompt {
        match state.store.update_agent_system_prompt(agent_id, sp) {
            Ok(n) if n > 0 => persisted.push(format!("system_prompt (column, {n} row(s))")),
            Ok(_) => {
                // No project_agents row (e.g. the built-in `default` agent).
                // Fall back to a soul file so the change isn't lost.
                state
                    .store
                    .set_agent_file(agent_id, "system_prompt.md", sp)
                    .map_err(|e| format!("failed to persist system_prompt soul file: {e}"))?;
                persisted.push("system_prompt (soul file)".into());
            }
            Err(e) => return Err(format!("failed to persist system_prompt: {e}").into()),
        }
    }

    if name.is_some() || avatar.is_some() || bio.is_some() {
        // Merge into the existing profile.json soul file so a partial
        // update doesn't clobber previously-set fields.
        let mut profile = state
            .store
            .get_agent_file(agent_id, "profile.json")
            .ok()
            .flatten()
            .and_then(|f| serde_json::from_str::<serde_json::Value>(&f.content).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        if let Some(v) = name {
            profile.insert("name".into(), serde_json::json!(v));
            persisted.push("name".into());
        }
        if let Some(v) = avatar {
            profile.insert("avatar".into(), serde_json::json!(v));
            persisted.push("avatar".into());
        }
        if let Some(v) = bio {
            profile.insert("bio".into(), serde_json::json!(v));
            persisted.push("bio".into());
        }
        let content = serde_json::to_string_pretty(&serde_json::Value::Object(profile))
            .unwrap_or_else(|_| "{}".into());
        state
            .store
            .set_agent_file(agent_id, "profile.json", &content)
            .map_err(|e| format!("failed to persist profile.json soul file: {e}"))?;
    }

    // Notify any UI listener (best-effort) and record a memory note.
    let _ = app_handle.emit("agent-profile-updated", serde_json::Value::Object(updates));

    let memory_content = format!(
        "Updated profile for agent '{}': {}",
        agent_id,
        persisted.join(", ")
    );
    let emb_client = state.embedding_client();
    let _ = memory::store_memory(
        &state.store,
        &memory_content,
        "fact",
        5,
        emb_client.as_ref(),
        None,
    )
    .await;

    let mut result_parts = vec![format!("Updated and persisted profile for '{}':", agent_id)];
    if let Some(v) = name {
        result_parts.push(format!("- **Name**: {} (soul file)", v));
    }
    if let Some(v) = avatar {
        result_parts.push(format!("- **Avatar**: {} (soul file)", v));
    }
    if let Some(v) = bio {
        result_parts.push(format!("- **Bio**: {} (soul file)", v));
    }
    if system_prompt.is_some() {
        result_parts.push("- **System Prompt**: persisted".into());
    }

    Ok(result_parts.join("\n"))
}

async fn execute_create_agent(
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> EngineResult<String> {
    let name = args["name"]
        .as_str()
        .ok_or("create_agent: missing 'name'")?;
    let role = args["role"]
        .as_str()
        .ok_or("create_agent: missing 'role'")?;
    let system_prompt = args["system_prompt"]
        .as_str()
        .ok_or("create_agent: missing 'system_prompt'")?;
    let specialty = args["specialty"].as_str().unwrap_or("general");
    let model = args["model"].as_str().filter(|s| !s.is_empty());
    let capabilities: Vec<String> = args["capabilities"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let agent_id = format!("agent-{}-{}", slug, timestamp);

    info!(
        "[engine] create_agent tool: creating '{}' as {}",
        name, agent_id
    );

    let state = app_handle
        .try_state::<EngineState>()
        .ok_or("Engine state not available")?;

    let agent = crate::engine::types::ProjectAgent {
        agent_id: agent_id.clone(),
        role: role.to_string(),
        specialty: specialty.to_string(),
        status: "idle".into(),
        current_task: None,
        model: model.map(String::from),
        system_prompt: Some(system_prompt.to_string()),
        capabilities: capabilities.clone(),
    };

    state.store.add_project_agent("_standalone", &agent)?;

    let memory_content = format!(
        "Created agent '{}' (id: {}, role: {}, specialty: {})",
        name, agent_id, role, specialty
    );
    let emb_client = state.embedding_client();
    let _ = memory::store_memory(
        &state.store,
        &memory_content,
        "fact",
        5,
        emb_client.as_ref(),
        None,
    )
    .await;

    Ok(format!(
        "Successfully created agent '{}'!\n\n\
        - **Agent ID**: {}\n\
        - **Role**: {}\n\
        - **Specialty**: {}\n\
        - **Model**: {}\n\
        - **Capabilities**: {}\n\n\
        The agent is now available in the Agents view.",
        name,
        agent_id,
        role,
        specialty,
        model.unwrap_or("(uses default)"),
        if capabilities.is_empty() {
            "all tools".to_string()
        } else {
            capabilities.join(", ")
        }
    ))
}

async fn execute_agent_list(app_handle: &tauri::AppHandle) -> EngineResult<String> {
    let state = app_handle
        .try_state::<EngineState>()
        .ok_or("Engine state not available")?;

    let backend_agents = state.store.list_all_agents().unwrap_or_default();

    let mut output = String::from("# Agents in System\n\n");
    output.push_str("1. **Default Agent** (id: `default`)\n   Role: Boss / Main Agent\n\n");

    let mut idx = 2;
    for (_project_id, agent) in &backend_agents {
        output.push_str(&format!(
            "{}. **{}** (id: `{}`)\n   Role: {} | Specialty: {}\n   Model: {}\n   Capabilities: {}\n\n",
            idx,
            agent.agent_id,
            agent.agent_id,
            agent.role,
            agent.specialty,
            agent.model.as_deref().unwrap_or("default"),
            if agent.capabilities.is_empty() { "all".into() } else { agent.capabilities.join(", ") },
        ));
        idx += 1;
    }

    output.push_str("**Note**: Community-skill assignment was removed in OPIDE phase 1.");
    Ok(output)
}

// ── manage_session ─────────────────────────────────────────────────────

async fn execute_manage_session(
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> EngineResult<String> {
    let action = args["action"]
        .as_str()
        .ok_or("Missing 'action' parameter (must be 'list', 'clear', or 'delete')")?;

    let state = app_handle
        .try_state::<EngineState>()
        .ok_or("Engine state not available")?;

    match action {
        "list" => {
            let filter = args["filter"].as_str().unwrap_or("");
            let sessions = state.store.list_sessions(200)?;
            let filtered: Vec<_> = if filter.is_empty() {
                sessions
            } else {
                sessions
                    .into_iter()
                    .filter(|s| s.id.contains(filter))
                    .collect()
            };

            if filtered.is_empty() {
                return Ok(format!(
                    "No sessions found{}.",
                    if filter.is_empty() {
                        String::new()
                    } else {
                        format!(" matching '{}'", filter)
                    }
                ));
            }

            let mut lines = vec![format!(
                "**Sessions** ({}{})\n",
                filtered.len(),
                if filter.is_empty() {
                    String::new()
                } else {
                    format!(", filter: '{}'", filter)
                }
            )];

            for s in &filtered {
                let msg_count = state
                    .store
                    .get_messages(&s.id, 1000)
                    .map(|msgs| msgs.len())
                    .unwrap_or(0);
                let label = s.label.as_deref().unwrap_or("");
                let agent = s.agent_id.as_deref().unwrap_or("?");
                let prefix = if s.id.starts_with("eng-discord") {
                    "[discord]"
                } else if s.id.starts_with("eng-telegram") {
                    "[telegram]"
                } else if s.id.starts_with("eng-slack") {
                    "[slack]"
                } else if s.id.starts_with("eng-task") {
                    "[task]"
                } else {
                    "[chat]"
                };
                lines.push(format!(
                    "{} `{}` — {} msgs, agent={}{}",
                    prefix,
                    s.id,
                    msg_count,
                    agent,
                    if label.is_empty() {
                        String::new()
                    } else {
                        format!(", label=\"{}\"", label)
                    }
                ));
            }
            Ok(lines.join("\n"))
        }
        "clear" => {
            let session_id = args["session_id"]
                .as_str()
                .ok_or("'session_id' is required for 'clear' action")?;

            // Support prefix matching for bulk clear
            if session_id.contains('*') || state.store.get_session(session_id)?.is_none() {
                // Try prefix match
                let prefix = session_id.trim_end_matches('*');
                let sessions = state.store.list_sessions(500)?;
                let matching: Vec<_> = sessions
                    .iter()
                    .filter(|s| s.id.starts_with(prefix))
                    .collect();
                if matching.is_empty() {
                    return Err(format!("No sessions found matching '{}'", session_id).into());
                }
                let mut cleared = 0;
                for s in &matching {
                    state.store.clear_messages(&s.id)?;
                    cleared += 1;
                }
                Ok(format!(
                    "Cleared messages from {} session(s) matching '{}'.",
                    cleared, prefix
                ))
            } else {
                state.store.clear_messages(session_id)?;
                info!(
                    "[manage_session] Cleared messages from session: {}",
                    session_id
                );
                Ok(format!("Cleared all messages from session '{}'. The session will start fresh on next message.", session_id))
            }
        }
        "delete" => {
            let session_id = args["session_id"]
                .as_str()
                .ok_or("'session_id' is required for 'delete' action")?;

            if session_id.contains('*') || state.store.get_session(session_id)?.is_none() {
                let prefix = session_id.trim_end_matches('*');
                let sessions = state.store.list_sessions(500)?;
                let matching: Vec<_> = sessions
                    .iter()
                    .filter(|s| s.id.starts_with(prefix))
                    .collect();
                if matching.is_empty() {
                    return Err(format!("No sessions found matching '{}'", session_id).into());
                }
                let mut deleted = 0;
                for s in &matching {
                    state.store.delete_session(&s.id)?;
                    deleted += 1;
                }
                Ok(format!(
                    "Deleted {} session(s) matching '{}'.",
                    deleted, prefix
                ))
            } else {
                state.store.delete_session(session_id)?;
                info!("[manage_session] Deleted session: {}", session_id);
                Ok(format!(
                    "Deleted session '{}' and all its messages.",
                    session_id
                ))
            }
        }
        _ => Err(format!(
            "Invalid action '{}'. Must be 'list', 'clear', or 'delete'.",
            action
        )
        .into()),
    }
}
