// Paw Commands — Chat & Session System Layer
//
// Thin Tauri command wrappers for:
//   - Chat (engine_chat_send, engine_chat_history)
//   - Sessions (engine_sessions_list, _rename, _delete, _clear, _compact)
//   - Tool approval (engine_approve_tool)
//
// Heavy logic lives in crate::engine::chat (the organism).
// These functions: extract state → call organisms → return.

use log::{error, info, warn};
use tauri::{Emitter, Manager, State};

use crate::commands::state::{resolve_provider_for_model, EngineState};
use crate::engine::agent_loop;
use crate::engine::chat as chat_org;
use crate::engine::engram;
use crate::engine::memory;
use crate::engine::providers::AnyProvider;
use crate::engine::types::*;
use crate::engine::util::safe_truncate;

// ── Project rules (Cursor-style workspace AI instructions) ─────────────────────

/// Read project-level AI rules from the open workspace and format them as a
/// system-prompt block. Honours OPIDE-native, emerging-standard, and Cursor
/// formats so users can drop in rules from any of them:
///   - `.opide/rules.md`         (OPIDE native)
///   - `AGENTS.md` / `CLAUDE.md`  (emerging standards, repo root)
///   - `.cursorrules`            (legacy Cursor)
///   - `.cursor/rules/*.md|.mdc` (current Cursor)
///
/// All found sources are concatenated. Best-effort: unreadable/empty files are
/// skipped, and the total is capped so a huge rules file can't blow the token
/// budget. Returns None when no rules exist.
fn read_project_rules(workspace: &str) -> Option<String> {
    use std::path::{Path, PathBuf};
    let root = Path::new(workspace);
    let mut blocks: Vec<String> = Vec::new();

    let read_trimmed = |p: &Path| -> Option<String> {
        std::fs::read_to_string(p).ok().and_then(|t| {
            let t = t.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        })
    };

    // Single-file sources, in priority order.
    for rel in [".opide/rules.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"] {
        if let Some(t) = read_trimmed(&root.join(rel)) {
            blocks.push(format!("### {rel}\n{t}"));
        }
    }

    // Cursor rules directory: .cursor/rules/*.md and *.mdc (sorted for stability).
    if let Ok(entries) = std::fs::read_dir(root.join(".cursor").join("rules")) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| x == "md" || x == "mdc")
            })
            .collect();
        files.sort();
        for p in files {
            if let Some(t) = read_trimmed(&p) {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("rule");
                blocks.push(format!("### .cursor/rules/{name}\n{t}"));
            }
        }
    }

    if blocks.is_empty() {
        return None;
    }

    let mut joined = blocks.join("\n\n");
    const MAX: usize = 16_000; // ~4K tokens — generous, but bounded.
    if joined.len() > MAX {
        crate::engine::util::safe_truncate_in_place(
            &mut joined,
            MAX,
            "\n\n[project rules truncated to fit context]",
        );
    }

    Some(format!(
        "## Project Rules\n\
         The user has defined project-specific rules for this workspace. Treat \
         them as binding instructions that override general defaults where they \
         conflict.\n\n{joined}"
    ))
}

// ── Chat ─────────────────────────────────────────────────────────────────────

/// Send a chat message and run the agent loop.
/// Returns immediately with a run_id; results stream via `engine-event` Tauri events.
#[tauri::command]
pub async fn engine_chat_send(
    app_handle: tauri::AppHandle,
    state: State<'_, EngineState>,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    let run_id = uuid::Uuid::new_v4().to_string();

    // Swarm counter reset removed in OPIDE phase 1 (engine::swarm deleted).

    // ── Resolve or create session ──────────────────────────────────────────
    let session_id = match &request.session_id {
        Some(id) if !id.is_empty() => {
            // Ensure session exists in the database (callers may pass custom IDs)
            if state.store.get_session(id)?.is_none() {
                let raw = request.model.clone().unwrap_or_default();
                let model = if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
                    let cfg = state.config.lock();
                    cfg.default_model
                        .clone()
                        .unwrap_or_else(|| "gpt-4o".to_string())
                } else {
                    raw
                };
                state.store.create_session(
                    id,
                    &model,
                    request.system_prompt.as_deref(),
                    request.agent_id.as_deref(),
                )?;
            }
            id.clone()
        }
        _ => {
            let new_id = format!("eng-{}", uuid::Uuid::new_v4());
            let raw = request.model.clone().unwrap_or_default();
            let model = if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
                let cfg = state.config.lock();
                cfg.default_model
                    .clone()
                    .unwrap_or_else(|| "gpt-4o".to_string())
            } else {
                raw
            };
            state.store.create_session(
                &new_id,
                &model,
                request.system_prompt.as_deref(),
                request.agent_id.as_deref(),
            )?;
            new_id
        }
    };

    // ── Request queue: if a run is already active for this session, queue ──
    // VS Code pattern: instead of rejecting "Request already in progress",
    // queue the message and signal the active agent to wrap up.
    {
        let has_active_run = state.active_runs.lock().contains_key(&session_id);
        if has_active_run {
            info!(
                "[engine] Session {} has active run — queuing request and signaling yield",
                session_id
            );

            // Signal the active agent to wrap up
            if let Some(signal) = state.yield_signals.lock().get(&session_id) {
                signal.request_yield();
            }

            // Queue this request for processing after the current one completes
            // We need the resolved model/provider, so resolve them now
            let (queued_provider, queued_model) = {
                let cfg = state.config.lock();
                let raw = request.model.clone().unwrap_or_default();
                let m = if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
                    cfg.default_model
                        .clone()
                        .unwrap_or_else(|| "gpt-4o".to_string())
                } else {
                    // B174: notify on alias rewrites so the UI can surface the swap.
                    crate::engine::state::normalize_model_name_with_notice(&raw, Some(&app_handle))
                };
                let p = resolve_provider_for_model(&m, &cfg.providers)
                    .or_else(|| {
                        cfg.default_provider
                            .as_ref()
                            .and_then(|dp| cfg.providers.iter().find(|p| p.id == *dp).cloned())
                    })
                    .or_else(|| cfg.providers.first().cloned());
                match p {
                    Some(provider) => (provider, m),
                    None => return Err("No AI provider configured.".into()),
                }
            };

            let queued = crate::engine::state::QueuedRequest {
                request: request.clone(),
                provider_config: queued_provider,
                model: queued_model,
                system_prompt: request.system_prompt.clone(),
            };
            state
                .request_queue
                .lock()
                .entry(session_id.clone())
                .or_default()
                .push(queued);

            // Return immediately — the queue processor will handle this request
            return Ok(ChatResponse {
                run_id: format!("queued-{}", uuid::Uuid::new_v4()),
                session_id,
            });
        }
    }

    // ── Store workspace path for working memory injection ─────────────────
    // The agent loop reads OPIDE_NOTES.md from this path each round to
    // re-inject the agent's own notes, preventing context-loss loops.
    if let Some(ref wp) = request.workspace_path {
        if !wp.is_empty() {
            state.session_workspaces.lock().insert(session_id.clone(), wp.clone());
        }
    }

    // ── Resolve model and provider ─────────────────────────────────────────
    let (provider_config, model) = {
        let cfg = state.config.lock();

        let raw_model = request.model.clone().unwrap_or_default();
        let base_model = if raw_model.is_empty() || raw_model.eq_ignore_ascii_case("default") {
            cfg.default_model
                .clone()
                .unwrap_or_else(|| "gpt-4o".to_string())
        } else {
            raw_model
        };

        let user_explicitly_chose_model = request
            .model
            .as_ref()
            .is_some_and(|m| !m.is_empty() && !m.eq_ignore_ascii_case("default"));
        let (model, was_downgraded) = if !user_explicitly_chose_model {
            cfg.model_routing
                .resolve_auto_tier(&request.message, &base_model)
        } else {
            (base_model, false)
        };
        if was_downgraded {
            info!(
                "[engine] Auto-tier: simple task → using cheap model '{}' instead of default",
                model
            );
        }

        // B174: same alias-rewrite notice on the second resolution path.
        let model = crate::engine::state::normalize_model_name_with_notice(&model, Some(&app_handle));

        let provider = if let Some(pid) = &request.provider_id {
            cfg.providers.iter().find(|p| p.id == *pid).cloned()
        } else {
            let resolved = resolve_provider_for_model(&model, &cfg.providers)
                .or_else(|| {
                    cfg.providers
                        .iter()
                        .find(|p| p.default_model.as_deref() == Some(model.as_str()))
                        .cloned()
                })
                .or_else(|| {
                    cfg.default_provider
                        .as_ref()
                        .and_then(|dp| cfg.providers.iter().find(|p| p.id == *dp).cloned())
                })
                .or_else(|| cfg.providers.first().cloned());

            // Safety: if we resolved to an Azure Foundry provider for a
            // standard model (gpt-*, o1-*, etc.), check if a direct OpenAI
            // provider exists and prefer it. Azure Foundry uses a different
            // API format (Responses API) that may not be compatible.
            if let Some(ref p) = resolved {
                if p.kind == ProviderKind::AzureFoundry
                    && (model.starts_with("gpt") || model.starts_with("o1")
                        || model.starts_with("o3") || model.starts_with("o4"))
                {
                    let direct_openai = cfg.providers.iter().find(|pp| {
                        pp.kind == ProviderKind::OpenAI
                            && pp.base_url.as_deref()
                                .is_some_and(|u| u.contains("api.openai.com"))
                    });
                    if let Some(openai) = direct_openai {
                        log::info!("[engine] Preferring direct OpenAI provider over Azure Foundry for model '{}'", model);
                        Some(openai.clone())
                    } else {
                        resolved
                    }
                } else {
                    resolved
                }
            } else {
                resolved
            }
        };

        match provider {
            Some(p) => (p, model),
            None => {
                return Err(
                    "No AI provider configured. Go to Settings → Engine to add an API key.".into(),
                )
            }
        }
    };

    // ── Store the user message ─────────────────────────────────────────────
    let user_msg = StoredMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        role: "user".into(),
        content: request.message.clone(),
        tool_calls_json: None,
        tool_call_id: None,
        name: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        tool_success: None,
    };
    state.store.add_message(&user_msg)?;

    // ── Base system prompt ─────────────────────────────────────────────────
    let mut base_system_prompt = request.system_prompt.clone().or_else(|| {
        let cfg = state.config.lock();
        cfg.default_system_prompt.clone()
    });

    // ── Project Rules (Cursor-style workspace AI instructions) ─────────────
    // Read .opide/rules.md / AGENTS.md / CLAUDE.md / .cursorrules / .cursor/rules
    // from the open workspace and fold them into the base prompt. Folding into
    // base_system_prompt means BOTH the Engram ContextBuilder path and the
    // compose_chat_system_prompt fallback pick them up from one place.
    if let Some(ws) = state.active_workspace.lock().clone() {
        if let Some(rules) = read_project_rules(&ws) {
            base_system_prompt = Some(match base_system_prompt {
                Some(bp) if !bp.trim().is_empty() => format!("{bp}\n\n{rules}"),
                _ => rules,
            });
        }
    }

    // ── Soul context + today's memories ───────────────────────────────────
    let agent_id_owned = request
        .agent_id
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let core_context = state
        .store
        .compose_core_context(&agent_id_owned)
        .unwrap_or(None);
    if let Some(ref cc) = core_context {
        info!(
            "[engine] Core soul context loaded ({} chars) for agent '{}'",
            cc.len(),
            agent_id_owned
        );
    } else {
        info!(
            "[engine] No core soul files found for agent '{}'",
            agent_id_owned
        );
    }

    let (todays_memories, _todays_memory_contents) = {
        let tm = state
            .store
            .get_todays_memories(&agent_id_owned)
            .unwrap_or(None);
        let contents = state
            .store
            .get_todays_memory_contents(&agent_id_owned)
            .unwrap_or_default();
        (tm, contents)
    };
    if let Some(ref tm) = todays_memories {
        info!(
            "[engine] Today's memory notes injected ({} chars, {} entries)",
            tm.len(),
            _todays_memory_contents.len()
        );
    }

    // ── Auto-capture flag ──────────────────────────────────────────────────
    let auto_capture_on = state.memory_config.lock().auto_capture;

    // ── Skill instructions ─────────────────────────────────────────────────
    // OpenPawz skill instructions removed in OPIDE phase 1. IDE-side WASM
    // skills are surfaced through ExternalToolExecutor instead.
    let _ = &agent_id_owned;
    let has_ide_executor = app_handle
        .try_state::<Box<dyn crate::engine::tools::ExternalToolExecutor>>()
        .is_some();
    let skill_instructions = String::new();
    if !skill_instructions.is_empty() {
        info!(
            "[engine] Skill instructions injected ({} chars)",
            skill_instructions.len()
        );
    }

    // ── Runtime context block (extracted values for organism) ─────────────
    let runtime_context = {
        let cfg = state.config.lock();
        let provider_name = cfg
            .providers
            .iter()
            .find(|p| Some(p.id.clone()) == cfg.default_provider)
            .or_else(|| cfg.providers.first())
            .map(|p| format!("{} ({:?})", p.id, p.kind))
            .unwrap_or_else(|| "unknown".into());
        let user_tz = cfg.user_timezone.clone();
        chat_org::build_runtime_context(
            &model,
            &provider_name,
            &session_id,
            &agent_id_owned,
            &user_tz,
        )
    };

    // ── Compose system prompt + recall + history via Engram ContextBuilder ──
    // The ContextBuilder uses accurate token counting via the model capability
    // registry, budget-aware assembly (priority-ordered section dropping),
    // and BM25+vector+graph fusion for auto-recall. This replaces the old
    // compose_chat_system_prompt → budget trimming → load_conversation pipeline.
    // In OPIDE mode: skip the agent roster (architect, coder, fixer, reviewer)
    let agent_roster = if has_ide_executor {
        None
    } else {
        chat_org::build_agent_roster(&state.store, &agent_id_owned)
    };

    let auto_recall_on = {
        let mcfg = state.memory_config.lock();
        mcfg.auto_recall
    };

    let context_window_override = {
        let cfg = state.config.lock();
        cfg.context_window_tokens
    };

    // Prune BEFORE loading — previously this ran after the agent loop so it had
    // zero effect on the current request. Moving it here means the loaded history
    // is already capped before context building starts.
    {
        use crate::atoms::constants::CHAT_SESSION_MAX_MESSAGES;
        match state
            .store
            .prune_session_messages(&session_id, CHAT_SESSION_MAX_MESSAGES)
        {
            Ok(n) if n > 0 => info!(
                "[engine] Pre-load prune: removed {} messages from session {}",
                n, session_id
            ),
            Err(e) => warn!("[engine] Pre-load prune failed: {}", e),
            _ => {}
        }
    }

    // Load raw conversation history for the ContextBuilder to budget-trim
    let raw_messages = state
        .store
        .load_conversation_raw(&session_id, Some(&agent_id_owned))
        .unwrap_or_default();

    let history_pairs: Vec<(String, String)> = {
        // Strip tool execution pairs before they reach the model's context.
        // Tool call/result pairs are ephemeral execution records — the findings
        // they produced live in OPIDE_NOTES.md and Engram session summaries.
        // Sending 40+ raw tool rounds to the model creates "tool inertia": it
        // pattern-matches its history and keeps using tools even when the user
        // just wants a conversation. Every other LLM product does this — tool
        // calls are rendered in the UI but only text responses go to the model.
        //
        // Stripped:
        //   - role == "tool"      (tool results)
        //   - role == "assistant" with tool_calls_json (tool-dispatch turns)
        // Kept:
        //   - role == "user"      (all user messages)
        //   - role == "assistant" without tool_calls_json (text summaries/answers)
        let pairs: Vec<(String, String)> = raw_messages
            .iter()
            .filter(|m| {
                if m.role == "tool" {
                    return false;
                }
                if m.role == "assistant" && m.tool_calls_json.is_some() {
                    return false;
                }
                true
            })
            .map(|m| (m.role.clone(), m.content.clone()))
            .collect();

        // On redirect: prune old history so the user's new message has weight.
        // Keep only pair[0] (original user task) + a gap notice + the last
        // REDIRECT_TAIL pairs. With tool pairs already stripped, these are
        // clean conversational turns — no mid-round cut risk.
        // The gap notice uses "user" role — "system" mid-conversation is
        // rejected by the OpenAI API with a 400.
        const REDIRECT_TAIL: usize = 24;
        if request.is_redirect && pairs.len() > REDIRECT_TAIL + 1 {
            let trimmed = pairs.len() - 1 - REDIRECT_TAIL;
            let mut pruned = Vec::with_capacity(REDIRECT_TAIL + 2);
            pruned.push(pairs[0].clone()); // original user task
            pruned.push(("user".to_string(),
                format!("[{} earlier tool-call rounds trimmed — see OPIDE_NOTES.md for findings so far]",
                    trimmed)));
            pruned.extend_from_slice(&pairs[pairs.len() - REDIRECT_TAIL..]);
            info!("[engine] Redirect: pruned history to {} pairs (was {})", pruned.len(), pairs.len());
            pruned
        } else {
            pairs
        }
    };

    let emb_client_for_recall = state.embedding_client();
    let recall_scope = crate::atoms::engram_types::MemoryScope {
        global: false,
        agent_id: Some(agent_id_owned.clone()),
        ..Default::default()
    };

    // ── Activate Cognitive State (Engram three-tier pipeline) ────────────
    // Get or create the per-agent CognitiveState. This holds the sensory
    // buffer (Tier 0) and working memory (Tier 1). Tier 2 is SessionStore.
    // Uses Arc<tokio::sync::Mutex> per agent — safe to hold across .await.
    let cognitive_lock = state.get_cognitive_state(&agent_id_owned);
    let mut cognitive = cognitive_lock.lock().await;

    // Decay working memory priorities each turn (0.95× factor)
    cognitive.decay_turn();

    // On redirect: clear momentum immediately so the recalled-context trajectory
    // doesn't bias the new request toward the old task. detect_user_override in
    // channels/agent.rs also clears momentum, but only on keyword match — this
    // fires unconditionally for any is_redirect request.
    if request.is_redirect {
        cognitive.working_memory.clear_momentum();
        cognitive.working_memory.evict_stale_task_slots();
        info!("[engine] Redirect: momentum + stale task slots cleared for agent '{}'", agent_id_owned);
    }

    // §8.2 Adapt WM budget to the actual model being used this turn.
    // The CognitiveState may have been created with the default model's budget,
    // but auto-tier routing or explicit model selection can change the model.
    cognitive.adapt_wm_budget(&model);

    let mut builder = engram::context_builder::ContextBuilder::new(&model)
        .context_window(context_window_override);

    // ── Inject platform awareness + foreman protocol (priority 0 — never dropped)
    // These were missing from the ContextBuilder path, causing the agent to lose
    // self-awareness of what OpenPawz is and what tools/capabilities it has.
    // In OPIDE: use IDE prompts instead of generic OpenPawz platform awareness.
    //
    // B197: inject the active workspace path so the agent thinks of paths
    // relative to the user's project. Operations outside the workspace
    // require user approval (enforced server-side in host_api.rs).
    let workspace_block = {
        let ws = state.active_workspace.lock().clone();
        match ws.as_deref() {
            Some(path) if !path.is_empty() => format!(
                "\n\n## Active workspace\n\
                 The user's open project is at `{}`. Treat this folder as your default \
                 working directory. Prefer relative paths inside this tree. Writes \
                 outside the workspace are still possible but will require explicit \
                 user approval through the IDE's review panel — only step outside the \
                 project when the user has clearly asked you to.",
                path,
            ),
            _ => "\n\n## Active workspace\n\
                  No workspace is currently open in OPIDE. Suggest the user open a \
                  folder (or call `ide_open_workspace` if they tell you a path) before \
                  doing project work. File writes outside an obvious temp dir will \
                  require explicit user approval.".to_string(),
        }
    };
    builder = builder.platform_awareness(
        format!(
            "{}\n\n{}{}",
            chat_org::build_ide_platform_prompt(),
            chat_org::build_ide_coding_guidelines(),
            workspace_block,
        )
    );
    // Use IDE-specific MCP note instead of foreman.md — keeps n8n/Slack/worker
    // model instructions (and the "Architect vs Foreman" framing) out of OPIDE.
    builder = builder.foreman_protocol(chat_org::build_ide_mcp_prompt().to_string());

    if let Some(ref bp) = base_system_prompt {
        builder = builder.base_prompt(bp.clone());
    }
    builder = builder.runtime_context(runtime_context);
    if let Some(ref cc) = core_context {
        builder = builder.core_context(cc.clone());
    }
    if let Some(ref tm) = todays_memories {
        builder = builder.todays_memories(tm.clone());
    }
    if !skill_instructions.is_empty() {
        builder = builder.skill_instructions(skill_instructions.clone());
    }
    if let Some(ref roster) = agent_roster {
        builder = builder.agent_roster(roster.clone());
    }
    // In OPIDE mode: skip engram recall — episodic memories from OpenPawz
    // sessions reinforce passive "report and wait" behavior instead of
    // autonomous fix-and-iterate. The IDE agent should be driven by the
    // system prompt, AST tools, and WASM skills, not recalled memories.
    if auto_recall_on && !has_ide_executor {
        builder = builder.recall_from(
            &state.store,
            emb_client_for_recall.as_ref(),
            recall_scope,
            request.message.clone(),
        );
        builder = builder.hnsw_index(&state.hnsw_index);
    }
    // Wire working memory into the ContextBuilder (Tier 1 → prompt assembly)
    builder = builder.working_memory(&cognitive.working_memory);

    // Pin the new user message outside trim_history so it is always the last
    // message in context regardless of token budget pressure. Pass everything
    // except the final pair to the builder — the final pair is the just-added
    // user message which we guarantee to append after build().
    let pinned_user_pair = history_pairs.last().cloned();
    let history_for_builder = if history_pairs.len() > 1 {
        history_pairs[..history_pairs.len() - 1].to_vec()
    } else {
        Vec::new()
    };
    builder = builder.messages(history_for_builder);

    // Build the assembled context
    let assembled = builder.build().await;

    let (_full_system_prompt, mut messages, _budget_report) = match assembled {
        Ok(ctx) => {
            info!(
                "[engram:chat] Context assembled: sys={}tok hist={}tok reply={}tok mem={} msgs={}/{}",
                ctx.budget.system_prompt_tokens,
                ctx.budget.history_tokens,
                ctx.budget.available_for_reply,
                ctx.budget.memories_injected,
                ctx.budget.messages_included,
                ctx.budget.messages_included + ctx.budget.messages_trimmed,
            );

            // §8.6 Trajectory-aware recall: push the raw query embedding into
            // the momentum vector. On subsequent turns, graph::search will blend
            // the new query with this history to bias recall toward conversation
            // direction — critical for anaphoric queries ("deploy it", "fix that").
            if let Some(emb) = ctx.query_embedding {
                cognitive.working_memory.push_momentum(emb);
            }

            // Prepend system prompt as a system message, then add history
            let mut chat_messages: Vec<Message> = Vec::new();
            if let Some(ref sys) = ctx.system_prompt {
                chat_messages.push(Message {
                    role: Role::System,
                    content: MessageContent::Text(sys.clone()),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    reasoning_content: None,
                });
            }
            // Convert (role, content) pairs to Message for the agent loop.
            // Cross-reference against raw_messages to restore tool_calls and
            // tool_call_id metadata that the ContextBuilder's (String, String)
            // pairs lost. Without this, the OpenAI API rejects the request
            // with "messages with role 'tool' must be a response to a
            // preceding message with 'tool_calls'" once prior tool exchanges
            // survive context trimming.
            let mut raw_cursor = 0; // track position in raw_messages for matching
            for (role, content) in &ctx.messages {
                // Try to find the matching raw StoredMessage so we can
                // restore tool_calls_json / tool_call_id / name.
                let mut tool_calls: Option<Vec<ToolCall>> = None;
                let mut tool_call_id: Option<String> = None;
                let mut msg_name: Option<String> = None;

                // Linear scan from raw_cursor — messages appear in the same
                // order, but trim_history may have dropped some from the front.
                for (i, rm) in raw_messages.iter().enumerate().skip(raw_cursor) {
                    if rm.role == *role && rm.content == *content {
                        tool_calls = rm
                            .tool_calls_json
                            .as_ref()
                            .and_then(|json| serde_json::from_str(json).ok());
                        tool_call_id = rm.tool_call_id.clone();
                        msg_name = rm.name.clone();
                        raw_cursor = i + 1;
                        break;
                    }
                }

                chat_messages.push(Message {
                    role: match role.as_str() {
                        "assistant" => Role::Assistant,
                        "system" => Role::System,
                        "tool" => Role::Tool,
                        _ => Role::User,
                    },
                    content: MessageContent::Text(content.clone()),
                    tool_calls,
                    tool_call_id,
                    name: msg_name,
                    reasoning_content: None,
                });
            }

            // Sanitize after reconstruction: context trimming may have
            // dropped assistant messages while keeping their tool results
            // (or vice versa). This prevents 400 errors from the API.
            crate::engine::agent_loop::helpers::sanitize_tool_pairs(&mut chat_messages);

            // Append the pinned user message last — always present, always at
            // the end, never subject to trim_history budget cuts.
            if let Some((_, pinned_content)) = pinned_user_pair {
                chat_messages.push(Message {
                    role: Role::User,
                    content: MessageContent::Text(pinned_content),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    reasoning_content: None,
                });
            }

            (ctx.system_prompt, chat_messages, ctx.budget)
        }
        Err(e) => {
            // Fallback to legacy system prompt composition if ContextBuilder fails
            warn!(
                "[engram:chat] ContextBuilder failed ({}), falling back to legacy path",
                e
            );
            let mut fallback_prompt = chat_org::compose_chat_system_prompt(
                base_system_prompt.as_deref(),
                {
                    let cfg = state.config.lock();
                    let provider_name = cfg
                        .providers
                        .iter()
                        .find(|p| Some(p.id.clone()) == cfg.default_provider)
                        .or_else(|| cfg.providers.first())
                        .map(|p| format!("{} ({:?})", p.id, p.kind))
                        .unwrap_or_else(|| "unknown".into());
                    let user_tz = cfg.user_timezone.clone();
                    chat_org::build_runtime_context(
                        &model,
                        &provider_name,
                        &session_id,
                        &agent_id_owned,
                        &user_tz,
                    )
                },
                core_context.as_deref(),
                todays_memories.as_deref(),
                &skill_instructions,
            );
            if let Some(ref roster) = agent_roster {
                if let Some(ref mut p) = fallback_prompt {
                    p.push_str("\n\n---\n\n");
                    p.push_str(roster);
                }
            }
            let context_window = context_window_override;
            let mut fallback_msgs = state.store.load_conversation(
                &session_id,
                fallback_prompt.as_deref(),
                Some(context_window),
                Some(&agent_id_owned),
            )?;
            // Strip tool execution pairs from the fallback path — mirrors the
            // history_pairs filter in the primary ContextBuilder path above.
            // Without this, the fallback sends 40+ tool rounds to the model,
            // causing tool inertia even when the user wants a plain response.
            fallback_msgs.retain(|m| {
                if m.role == Role::Tool {
                    return false;
                }
                if m.role == Role::Assistant
                    && m.tool_calls.as_ref().is_some_and(|tc| !tc.is_empty())
                {
                    return false;
                }
                true
            });
            let budget = engram::context_builder::BudgetReport::default();
            (fallback_prompt, fallback_msgs, budget)
        }
    };

    // ── Process attachments into multi-modal blocks (organism) ────────────
    chat_org::process_attachments(&request.message, &request.attachments, &mut messages);

    // Release cognitive state lock after ContextBuilder is done borrowing it.
    // The spawn closure will re-acquire it when the response is ready.
    drop(cognitive);

    // ── Clear loaded tools for this new chat turn ─────────────────────────
    // Tool RAG: reset the set of dynamically-loaded tools so each turn starts fresh.
    state.loaded_tools.lock().clear();

    // ── Build tool list (organism) — Tool RAG: core tools + previously loaded ─
    let loaded_tools = state.loaded_tools.lock().clone();
    let mut tools = chat_org::build_chat_tools(
        &state.store,
        request.tools_enabled.unwrap_or(true),
        request.tool_filter.as_deref(),
        &app_handle,
        &loaded_tools,
    );

    // ── Detect response loops (organism) ──────────────────────────────────
    // Skip on redirect: the STOP wrapper, history pruning, momentum clear, and
    // USER OVERRIDE message already provide strong redirection signal. Adding a
    // "you're looping" nudge on top would be contradictory noise — the agent
    // isn't looping, it just received a new direction.
    if !request.is_redirect {
        chat_org::detect_response_loop(&mut messages);
    }

    // ── Detect explicit user overrides (§59.2) ────────────────────────────
    // If the user explicitly tells the agent to stop, refocus, etc., inject
    // a strong system redirect and clear working memory momentum.
    if chat_org::detect_user_override(&mut messages) {
        let cognitive_lock = state.get_cognitive_state(&agent_id_owned);
        let mut cog = cognitive_lock.lock().await;
        cog.working_memory.clear_momentum();
        log::info!(
            "[engine] User override detected in chat — momentum cleared for '{}'",
            agent_id_owned
        );
    }
    // ── Detect implicit topic shifts ──────────────────────────────────────
    // After a tool-heavy exchange, if the user sends a short message that
    // doesn't look like a task continuation ("option 1", "yes", "go ahead"),
    // inject a gentle nudge and clear momentum so recall isn't biased.
    else if chat_org::detect_implicit_topic_shift(&mut messages) {
        let cognitive_lock = state.get_cognitive_state(&agent_id_owned);
        let mut cog = cognitive_lock.lock().await;
        cog.working_memory.clear_momentum();
        cog.working_memory.clear();

        // Strip today's memory notes from the system prompt — they anchor
        // the model to the old topic even after tool messages are stripped.
        if let Some(sys_msg) = messages.first_mut() {
            if sys_msg.role == Role::System {
                if let MessageContent::Text(ref mut text) = sys_msg.content {
                    if let Some(start) = text.find("## Today's Memory Notes") {
                        // Find the next section boundary (\n## or end)
                        let rest = &text[start..];
                        let end = rest[1..]
                            .find("\n## ")
                            .map(|i| start + 1 + i)
                            .unwrap_or(text.len());
                        text.replace_range(start..end, "");
                        log::info!("[engine] Stripped today's memory notes from system prompt (topic shift)");
                    }
                }
            }
        }
    }

    // Note: Topic detection and retry-override injection have been removed.
    // VS Code pattern: failed messages are deleted from history entirely
    // (in load_conversation → delete_failed_exchanges), so the model never
    // sees past failures and doesn't need prompt-engineering nudges.
    // Users can start a new session for topic changes (Ctrl+L / New Chat).

    // ── Extract remaining config values ───────────────────────────────────
    let (max_rounds, temperature) = {
        let cfg = state.config.lock();
        (cfg.max_tool_rounds, request.temperature)
    };
    let thinking_level = request.thinking_level.clone();
    let auto_approve_all = request.auto_approve_all;
    let user_approved_tools = request.user_approved_tools.clone();
    let tool_timeout = {
        let cfg = state.config.lock();
        cfg.tool_timeout_secs
    };
    let daily_budget = {
        let cfg = state.config.lock();
        cfg.daily_budget_usd
    };

    let session_id_clone = session_id.clone();
    let run_id_clone = run_id.clone();
    let approvals = state.pending_approvals.clone();
    let user_message_for_capture = request.message.clone();
    let pre_loop_msg_count = messages.len();
    let app = app_handle.clone();
    let agent_id_for_spawn = agent_id_owned.clone();
    let sem = state.run_semaphore.clone();
    let panic_session_id = session_id.clone();
    let panic_run_id = run_id.clone();
    let panic_app = app_handle.clone();
    let daily_tokens = state.daily_tokens.clone();
    let active_runs = state.active_runs.clone();
    let abort_session_id = session_id.clone();

    // ── Set up yield signal for this session (VS Code pattern) ────────────
    let yield_signal = {
        let mut signals = state.yield_signals.lock();
        let signal = signals.entry(session_id.clone()).or_default().clone();
        signal.reset(); // Fresh start for this request
        signal
    };
    let yield_signal_for_spawn = yield_signal.clone();
    let request_queue = state.request_queue.clone();
    let yield_signals_cleanup = state.yield_signals.clone();

    // ── Set up surface signal for this session ─────────────────────────────
    {
        let mut signals = state.surface_signals.lock();
        signals.entry(session_id.clone()).or_default().reset();
    }

    // ── Spawn agent loop ───────────────────────────────────────────────────
    let handle = tauri::async_runtime::spawn(async move {
        // Chat gets priority — short timeout then proceed anyway
        let _permit = match tokio::time::timeout(
            std::time::Duration::from_secs(2),
            sem.acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => Some(permit),
            _ => {
                info!("[engine] Chat bypassing concurrency limit (all slots busy)");
                None
            }
        };

        let provider = AnyProvider::from_config_auto(&provider_config, &app);

        match agent_loop::run_agent_turn(
            &app,
            &provider,
            &model,
            &mut messages,
            &mut tools,
            &session_id_clone,
            &run_id_clone,
            max_rounds,
            temperature,
            &approvals,
            tool_timeout,
            &agent_id_for_spawn,
            daily_budget,
            Some(&daily_tokens),
            thinking_level.as_deref(),
            auto_approve_all,
            &user_approved_tools,
            Some(&yield_signal_for_spawn),
        )
        .await
        {
            Ok(final_text) => {
                info!("[engine] Agent turn complete: {} chars", final_text.len());

                if let Some(engine_state) = app.try_state::<EngineState>() {
                    // Persist only NEW messages (skip pre-loaded history)
                    // Skip empty assistant messages — they waste context and
                    // cause the model to mimic the empty-response pattern.
                    for msg in messages.iter().skip(pre_loop_msg_count) {
                        if msg.role == Role::Assistant || msg.role == Role::Tool {
                            // Don't persist empty assistant messages that have
                            // no tool_calls. Assistant messages WITH tool_calls
                            // must always be persisted even if their text is
                            // empty — otherwise tool result messages become
                            // orphans and corrupt the conversation history.
                            if msg.role == Role::Assistant
                                && msg.tool_calls.as_ref().is_none_or(|tc| tc.is_empty())
                            {
                                let text = msg.content.as_text();
                                if text.trim().is_empty() {
                                    info!("[engine] Skipping empty assistant message (not persisting)");
                                    continue;
                                }
                            }
                            // B190: best-effort populate tool_success from the
                            // serialized content. The agent loop emits tool
                            // results as `Error: ...` on failure (see
                            // tools/mod.rs::dispatch's `output: format!("Error: {}", err)`
                            // path) so we can recover that signal cheaply
                            // without threading ToolResult through Message.
                            let tool_success = if msg.role == Role::Tool {
                                let text = msg.content.as_text();
                                Some(!text.starts_with("Error:") && !text.starts_with("ERROR"))
                            } else {
                                None
                            };
                            let stored = StoredMessage {
                                id: uuid::Uuid::new_v4().to_string(),
                                session_id: session_id_clone.clone(),
                                role: match msg.role {
                                    Role::Assistant => "assistant".into(),
                                    Role::Tool => "tool".into(),
                                    _ => "user".into(),
                                },
                                content: msg.content.as_text(),
                                tool_calls_json: msg
                                    .tool_calls
                                    .as_ref()
                                    .map(|tc| serde_json::to_string(tc).unwrap_or_default()),
                                tool_call_id: msg.tool_call_id.clone(),
                                name: msg.name.clone(),
                                created_at: chrono::Utc::now().to_rfc3339(),
                                tool_success,
                            };
                            if let Err(e) = engine_state.store.add_message(&stored) {
                                error!("[engine] Failed to store message: {}", e);
                            }
                        }
                    }

                    // ── Push message pair into sensory buffer (Tier 0) ──
                    // This feeds the three-tier cognitive pipeline so that
                    // recent exchanges are available in working memory.
                    if !final_text.is_empty() {
                        let cognitive_lock = engine_state.get_cognitive_state(&agent_id_for_spawn);
                        let mut cognitive = cognitive_lock.lock().await;
                        let wm_evictions =
                            cognitive.push_message(&user_message_for_capture, &final_text);
                        if wm_evictions > 0 {
                            info!(
                                "[engine] Sensory buffer push: {} WM evictions for agent '{}'",
                                wm_evictions, agent_id_for_spawn
                            );
                        }
                    }

                    // Auto-capture memorable facts via Engram (with dedup guard)
                    // Uses LLM-powered extraction for 5x better fact coverage.
                    // Falls back to heuristic extraction if LLM call fails.
                    if auto_capture_on && !has_ide_executor && !final_text.is_empty() {
                        let extraction_provider = AnyProvider::from_config_auto(&provider_config, &app);
                        let facts = memory::extract_memorable_facts_llm(
                            &user_message_for_capture,
                            &final_text,
                            &extraction_provider,
                            &model,
                        )
                        .await;
                        if !facts.is_empty() {
                            let emb_client = engine_state.embedding_client();
                            for (content, category) in &facts {
                                // Store in Engram (three-tier episodic memory)
                                match engram::bridge::store_auto_capture(
                                    &engine_state.store,
                                    content,
                                    category,
                                    emb_client.as_ref(),
                                    Some(&agent_id_for_spawn),
                                    Some(&session_id_clone),
                                    None, // no channel context
                                    None, // no channel user
                                    Some(&engine_state.hnsw_index),
                                )
                                .await
                                {
                                    Ok(Some(id)) => info!(
                                        "[engine] Auto-captured memory: {}",
                                        crate::engine::types::truncate_utf8(&id, 8)
                                    ),
                                    Ok(None) => {
                                        info!("[engine] Auto-capture skipped (near-duplicate)")
                                    }
                                    Err(e) => warn!("[engine] Engram auto-capture failed: {}", e),
                                }
                            }
                        }
                    }

                    // Session-end summary (powers "Today's Memory Notes" in future sessions)
                    // Uses LLM to generate a concise summary instead of truncating.
                    // Only store when actual tool work was done — plain chat responses
                    // are not worth memorizing and cause memory bloat.
                    // Rate-limit: skip if a session summary was stored in the last 5 minutes
                    // to prevent memory accumulation loops during rapid context switches.
                    let had_tool_calls = messages.iter().skip(pre_loop_msg_count).any(|m| {
                        m.role == Role::Tool
                            || m.tool_calls
                                .as_ref()
                                .map(|tc| !tc.is_empty())
                                .unwrap_or(false)
                    });
                    if had_tool_calls && !final_text.is_empty() {
                        // Generate a concise LLM summary instead of naive truncation
                        let session_summary = memory::generate_session_summary(
                            &user_message_for_capture,
                            &final_text,
                            &AnyProvider::from_config_auto(&provider_config, &app),
                            &model,
                        )
                        .await;
                        let emb_client = engine_state.embedding_client();

                        // Store session summary in Engram only (no legacy dual-write)
                        match engram::bridge::store_auto_capture(
                            &engine_state.store,
                            &session_summary,
                            "session",
                            emb_client.as_ref(),
                            Some(&agent_id_for_spawn),
                            Some(&session_id_clone),
                            None, // no channel context
                            None, // no channel user
                            Some(&engine_state.hnsw_index),
                        )
                        .await
                        {
                            Ok(Some(id)) => info!(
                                "[engine] Session summary stored in Engram ({} chars, id={})",
                                session_summary.len(),
                                safe_truncate(&id, 8)
                            ),
                            Ok(None) => info!("[engine] Session summary skipped (near-duplicate)"),
                            Err(e) => {
                                warn!("[engine] Engram session summary failed: {}", e)
                            }
                        }
                    }

                    // ── Auto-prune: moved to pre-load (before context building) ──
                    // Prune now runs before load_conversation_raw so the cap takes
                    // effect on the current request. The post-loop call was a no-op
                    // since the messages were already loaded into context by then.

                    // ── Auto-compact: DISABLED ──
                    // Auto-compaction replaces conversation history with a summary,
                    // which biases the model towards the old topic and prevents
                    // natural topic shifts. Manual compaction is still available
                    // via the session_compact command if a user explicitly wants it.
                    //
                    // Instead, we rely on:
                    //   - Auto-prune (above) to cap stored messages
                    //   - Mid-loop truncation (in agent_loop) to cap context window
                }
            }
            Err(e) => {
                error!("[engine] Agent turn failed: {}", e);
                let _ = app.emit(
                    "engine-event",
                    EngineEvent::Error {
                        session_id: session_id_clone,
                        run_id: run_id_clone,
                        message: e.to_string(),
                    },
                );
            }
        }
    });

    // ── Register abort handle for this session ─────────────────────────────
    active_runs
        .lock()
        .insert(abort_session_id.clone(), handle.inner().abort_handle());

    // ── Panic safety monitor + abort handle cleanup + queue processing ───
    let cleanup_runs = active_runs.clone();
    let cleanup_session_id = abort_session_id.clone();
    let queue_session_id = abort_session_id.clone();
    let queue_ref = request_queue.clone();
    let queue_app = app_handle.clone();
    let yield_cleanup_session = abort_session_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = handle.await;
        // Always clean up the abort handle and yield signal when the task finishes
        cleanup_runs.lock().remove(&cleanup_session_id);
        yield_signals_cleanup.lock().remove(&yield_cleanup_session);

        // ── Process next queued request (VS Code pattern) ─────────────
        // After the current request completes, check if there are queued
        // messages and process the next one.
        {
            let next = queue_ref.lock().get_mut(&queue_session_id).and_then(|q| {
                if q.is_empty() {
                    None
                } else {
                    Some(q.remove(0))
                }
            });
            if let Some(queued) = next {
                info!(
                    "[engine] Processing queued request for session {}",
                    queue_session_id
                );
                // Don't store the user message here — the normal engine_chat_send
                // flow will store it when the frontend re-sends. Storing here would
                // create a duplicate.
                //
                // Emit a queue-ready event so the frontend re-sends via normal flow.
                // The frontend listens for "engine-queue-ready" and calls engineChatSend
                // with the queued message, which goes through the full chat pipeline
                // (system prompt construction, context loading, tool building, etc.)
                let _ = queue_app.emit(
                    "engine-queue-ready",
                    serde_json::json!({
                        "sessionId": queue_session_id,
                        "message": queued.request.message,
                        "model": queued.request.model,
                    }),
                );
                info!("[engine] Emitted engine-queue-ready for frontend re-send");
            }
        }

        if let Err(ref err) = result {
            // Check if the error is a JoinError from cancellation
            let is_cancelled = matches!(err, tauri::Error::JoinError(je) if je.is_cancelled());
            if is_cancelled {
                info!(
                    "[engine] Agent task aborted by user for session {}",
                    cleanup_session_id
                );
                let _ = panic_app.emit(
                    "engine-event",
                    EngineEvent::Complete {
                        session_id: panic_session_id,
                        run_id: panic_run_id,
                        text: String::new(),
                        tool_calls_count: 0,
                        usage: None,
                        model: None,
                        total_rounds: None,
                        max_rounds: None,
                    },
                );
            } else {
                let msg = format!("Internal error: agent task crashed — {}", err);
                error!("[engine] {}", msg);
                let _ = panic_app.emit(
                    "engine-event",
                    EngineEvent::Error {
                        session_id: panic_session_id,
                        run_id: panic_run_id,
                        message: msg,
                    },
                );
            }
        }
    });

    Ok(ChatResponse { run_id, session_id })
}

/// Get chat message history for a session.
#[tauri::command]
pub fn engine_chat_history(
    state: State<'_, EngineState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<StoredMessage>, String> {
    state
        .store
        .get_messages(&session_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Inject a guidance message into an in-flight agent run.
/// The message is queued and injected into the agent's context as a system
/// message at the start of the next round — the run is never paused.
#[tauri::command]
pub fn engine_chat_inject(
    state: State<'_, EngineState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Ok(());
    }
    state
        .inject_queues
        .lock()
        .entry(session_id.clone())
        .or_default()
        .push(message.clone());
    info!(
        "[engine] Queued inject message for session {} ({} chars)",
        session_id,
        message.len()
    );
    Ok(())
}

/// Request the agent to surface its findings and pause at the next round boundary.
/// The agent will emit a `EngineEvent::Surfaced` with a summary, then stop.
/// The frontend can then have a real conversation before resuming.
#[tauri::command]
pub fn engine_chat_surface(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<(), String> {
    let mut signals = state.surface_signals.lock();
    let signal = signals.entry(session_id.clone()).or_default().clone();
    signal.request_surface();
    info!("[engine] Surface requested for session {}", session_id);
    Ok(())
}

/// Abort an in-flight agent run for the given session.
#[tauri::command]
pub fn engine_chat_abort(state: State<'_, EngineState>, session_id: String) -> Result<(), String> {
    let mut runs = state.active_runs.lock();
    if let Some(handle) = runs.remove(&session_id) {
        handle.abort();
        info!("[engine] Aborted agent run for session {}", session_id);
        Ok(())
    } else {
        warn!(
            "[engine] No active run found for session {} — may have already finished",
            session_id
        );
        Ok(()) // Not an error — the run may have completed between click and arrival
    }
}

/// Reset an agent's in-memory cognitive state when starting a new chat.
///
/// Clears working memory (task slots, momentum embeddings, sensory buffer) so the
/// agent does not resume its previous task on the next run. The engram (episodic
/// memories) and session message history are intentionally preserved — they are
/// long-term knowledge, not loop drivers.
#[tauri::command]
pub fn engine_agent_reset(
    state: State<'_, EngineState>,
    agent_id: String,
) -> Result<(), String> {
    // Drop the in-memory cognitive state so the next run starts fresh.
    // Working memory (task slots, momentum, sensory buffer) is the loop driver —
    // it tells the agent "I was doing X, continue X." The engram (episodic memories)
    // is long-term knowledge and is intentionally preserved across new chats.
    let mut states = state.cognitive_states.lock();
    if states.remove(&agent_id).is_some() {
        info!("[engine] Cleared cognitive state for agent {}", agent_id);
    }

    Ok(())
}

// ── Sessions ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn engine_sessions_list(
    state: State<'_, EngineState>,
    limit: Option<i64>,
    agent_id: Option<String>,
) -> Result<Vec<Session>, String> {
    state
        .store
        .list_sessions_filtered(limit.unwrap_or(50), agent_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_session_rename(
    state: State<'_, EngineState>,
    session_id: String,
    label: String,
) -> Result<(), String> {
    state
        .store
        .rename_session(&session_id, &label)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_session_delete(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<(), String> {
    state
        .store
        .delete_session(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_session_clear(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<(), String> {
    info!("[engine] Clearing messages for session {}", session_id);
    state
        .store
        .clear_messages(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_session_cleanup(
    state: State<'_, EngineState>,
    max_age_secs: Option<i64>,
    exclude_id: Option<String>,
) -> Result<usize, String> {
    let age = max_age_secs.unwrap_or(3600); // default: 1 hour
    state
        .store
        .cleanup_empty_sessions(age, exclude_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn engine_session_compact(
    state: State<'_, EngineState>,
    session_id: String,
) -> Result<crate::engine::compaction::CompactionResult, String> {
    info!(
        "[engine] Manual compaction requested for session {}",
        session_id
    );

    let (provider_config, model) = {
        let cfg = state.config.lock();
        let model = cfg
            .default_model
            .clone()
            .unwrap_or_else(|| "gpt-4o".to_string());
        let provider = cfg
            .default_provider
            .as_ref()
            .and_then(|dp| cfg.providers.iter().find(|p| p.id == *dp).cloned())
            .or_else(|| cfg.providers.first().cloned())
            .ok_or("No AI provider configured.")?;
        (provider, model)
    };

    let provider = crate::engine::providers::AnyProvider::from_config(&provider_config);
    let compact_config = crate::engine::compaction::CompactionConfig::default();
    let store_arc = std::sync::Arc::new(
        crate::engine::sessions::SessionStore::open().map_err(|e| e.to_string())?,
    );

    crate::engine::compaction::compact_session(
        &store_arc,
        &provider,
        &model,
        &session_id,
        &compact_config,
    )
    .await
    .map_err(|e| e.to_string())
}

// ── Tool approval ─────────────────────────────────────────────────────────────

/// B197: tell the engine which folder Monaco currently has open. Called by
/// the frontend's `open-workspace` listener so `host_api.rs` and the system
/// prompt builder can use the path to enforce workspace confinement
/// (writes outside the project require approval) and to steer the agent.
///
/// Pass `None`/empty to clear (no workspace open).
#[tauri::command]
pub fn engine_set_active_workspace(
    state: State<'_, EngineState>,
    path: Option<String>,
) -> Result<(), String> {
    let normalized = path.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    let mut guard = state
        .active_workspace
        .lock();
    *guard = normalized.clone();
    log::info!(
        "[engine] active workspace set to {}",
        normalized.as_deref().unwrap_or("(none)")
    );
    Ok(())
}

#[tauri::command]
pub fn engine_approve_tool(
    state: State<'_, EngineState>,
    tool_call_id: String,
    approved: bool,
) -> Result<(), String> {
    let mut map = state.pending_approvals.lock();

    if let Some(sender) = map.remove(&tool_call_id) {
        info!(
            "[engine] Tool approval resolved: {} → {}",
            tool_call_id,
            if approved { "ALLOWED" } else { "DENIED" }
        );
        let _ = sender.send(approved);
        Ok(())
    } else {
        // Stale approval — the backend already timed out or the tool call
        // completed before the frontend resolved it.  This is normal when
        // session overrides fire after a timeout.  Silently accept it.
        info!(
            "[engine] Stale approval (already resolved/timed-out): tool_call_id={}",
            tool_call_id
        );
        Ok(())
    }
}
