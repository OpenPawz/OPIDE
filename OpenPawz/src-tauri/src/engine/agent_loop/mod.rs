// Paw Agent Engine — Agentic Loop
// The core orchestration loop: send to model → tool calls → execute → repeat.
// This is the core agent loop that drives Pawz AI interactions.

pub(crate) mod helpers;
pub mod sandbox_enforcement;
#[cfg(feature = "trading")]
mod trading;

use crate::atoms::error::EngineResult;
use crate::engine::providers::AnyProvider;
use crate::engine::state::{DailyTokenTracker, PendingApprovals};
use crate::engine::telemetry::{integration as telem, RunCollector};
use crate::engine::tools;
use crate::engine::types::*;
use log::{info, warn};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
#[cfg(feature = "trading")]
use trading::check_trading_auto_approve;

/// Emit an engine event to both the Tauri webview frontend AND any SSE
/// subscribers (e.g. the Pawz VS Code extension via `/chat/stream`).
/// All `engine-event` emissions must go through this instead of calling
/// `app_handle.emit()` directly so SSE clients receive live streaming events.
fn fire(app: &tauri::AppHandle, event: EngineEvent) {
    let _ = app.emit("engine-event", &event);
    if let Some(es) = app.try_state::<crate::engine::state::EngineState>() {
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = es.sse_events.send(json);
        }
    }
}

/// Run a complete agent turn: send messages to the model, execute tool calls,
/// and repeat until the model produces a final text response or max rounds hit.
///
/// Emits `engine-event` Tauri events for real-time streaming to the frontend.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub async fn run_agent_turn(
    app_handle: &tauri::AppHandle,
    provider: &AnyProvider,
    model: &str,
    messages: &mut Vec<Message>,
    tools: &mut Vec<ToolDefinition>,
    session_id: &str,
    run_id: &str,
    max_rounds: u32,
    temperature: Option<f64>,
    pending_approvals: &PendingApprovals,
    tool_timeout_secs: u64,
    agent_id: &str,
    daily_budget_usd: f64,
    daily_tokens: Option<&DailyTokenTracker>,
    thinking_level: Option<&str>,
    auto_approve_all: bool,
    user_approved_tools: &[String],
    yield_signal: Option<&crate::engine::state::YieldSignal>,
) -> EngineResult<String> {
    let mut round = 0;
    let mut final_text = String::new();
    let mut last_input_tokens: u64 = 0; // Only the LAST round's input (= actual context size)
    let mut total_output_tokens: u64 = 0; // Sum of all rounds' output tokens
    let mut total_cache_read: u64 = 0; // Sum of all rounds' cache read tokens
    let mut total_cache_create: u64 = 0; // Sum of all rounds' cache creation tokens
    let mut fabrication_retries: u32 = 0; // Phase 4: count text-only retries to prevent fabrication

    // ── Telemetry: per-turn collector (Canvas Phase 5) ────────────────
    let mut telem_collector = RunCollector::new(session_id, run_id, model);
    let telem_root_id = telem_collector.root_span("agent_turn");
    let turn_start = Instant::now();
    let mut tool_duration_total_ms: u64 = 0;
    let mut tool_call_count: u32 = 0;

    // Circuit breaker: track consecutive failures per tool name.
    // After MAX_CONSECUTIVE_TOOL_FAILS of the same tool, inject a system nudge.
    // After HARD_STOP_TOOL_FAILS, block further execution of that tool entirely.
    let mut tool_fail_counter: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    const MAX_CONSECUTIVE_TOOL_FAILS: u32 = 3;
    const HARD_STOP_TOOL_FAILS: u32 = 5;

    // Repetition detector: track the tool-call "signature" (hashed tool names
    // + args) for each round.  If the same signature appears consecutively
    // MAX_REPEATED_SIGNATURES times, the model is stuck in a tool-calling loop
    // (common after model/context changes mid-conversation).
    let mut round_signatures: Vec<u64> = Vec::new();
    const MAX_REPEATED_SIGNATURES: usize = 3;

    // ── Phase 3: Binary IPC delta batcher ─────────────────────────────
    #[cfg(feature = "binary-ipc")]
    let mut delta_batcher = crate::engine::binary_ipc::EventBatcher::new(
        session_id,
        run_id,
        crate::engine::binary_ipc::BatchConfig::default(),
    );

    // ── Phase 4: Speculative tool execution tracking ──────────────────
    #[cfg(feature = "speculative")]
    let mut previous_tool: Option<String> = None;
    #[cfg(feature = "speculative")]
    let speculation_config = app_handle
        .try_state::<crate::engine::state::EngineState>()
        .map(|es| es.speculation_config.clone())
        .unwrap_or_default();
    #[cfg(feature = "speculative")]
    let mut speculation_stats = crate::engine::speculative::SpeculationStats::default();

    loop {
        round += 1;

        // ── Yield check: if a new user message was queued, wrap up gracefully ─
        // VS Code pattern: when yield is requested, the agent stops its loop
        // and returns whatever it has so far.  The queued message will be
        // processed next by the request queue handler.
        if let Some(ys) = yield_signal {
            if ys.is_yield_requested() {
                warn!(
                    "[engine] Yield requested — wrapping up agent turn at round {}",
                    round
                );
                if final_text.is_empty() {
                    final_text = format!(
                        "*(Redirected at round {} before producing a response.)*",
                        round
                    );
                } else {
                    let preview = if final_text.len() > 400 {
                        format!("{}…", &final_text[..400])
                    } else {
                        final_text.clone()
                    };
                    final_text = format!(
                        "*(Redirected at round {}. Last output before redirect:)*\n\n{}",
                        round, preview
                    );
                }
                fire(
                    app_handle,
                    EngineEvent::Complete {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        text: final_text.clone(),
                        tool_calls_count: 0,
                        usage: None,
                        model: None,
                        total_rounds: Some(round),
                        max_rounds: Some(max_rounds),
                    },
                );
                return Ok(final_text);
            }
        }

        if round > max_rounds {
            warn!(
                "[engine] Max tool rounds ({}) reached, stopping",
                max_rounds
            );
            if final_text.is_empty() {
                final_text = format!(
                    "I completed {} tool-call rounds but ran out of steps before I could \
                    write a final summary.  You can continue the conversation or increase \
                    the max tool rounds in Settings → Engine (currently {}).",
                    max_rounds, max_rounds
                );
                // Emit the fallback text so the frontend shows *something*
                fire(
                    app_handle,
                    EngineEvent::Complete {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        text: final_text.clone(),
                        tool_calls_count: 0,
                        usage: None,
                        model: None,
                        total_rounds: Some(round),
                        max_rounds: Some(max_rounds),
                    },
                );
            }
            return Ok(final_text);
        }

        if max_rounds < u32::MAX {
            info!(
                "[engine] Agent round {}/{} session={} run={}",
                round, max_rounds, session_id, run_id
            );
        } else {
            info!(
                "[engine] Agent round {} session={} run={}",
                round, session_id, run_id
            );
        }

        // ── Surface check: pause and emit findings summary if requested ──
        // User clicked "Surface" — agent stops here, fires Surfaced event with
        // a summary of what it found so far, then returns. Frontend unlocks chat.
        if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
            let surface_requested = es
                .surface_signals
                .lock()
                .get(session_id)
                .map(|s| s.is_surface_requested())
                .unwrap_or(false);
            if surface_requested {
                warn!(
                    "[engine] Surface requested — pausing agent turn at round {}",
                    round
                );
                let summary = if final_text.is_empty() {
                    format!(
                        "*(Surfaced at round {} — no output produced yet in this turn.)*",
                        round
                    )
                } else {
                    let preview = if final_text.len() > 600 {
                        format!("{}…", &final_text[..600])
                    } else {
                        final_text.clone()
                    };
                    format!(
                        "**Findings so far (round {}):**\n\n{}",
                        round, preview
                    )
                };
                fire(
                    app_handle,
                    EngineEvent::Surfaced {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        round,
                        summary,
                    },
                );
                return Ok(final_text);
            }
        }

        // ── Inject: drain any pending guidance messages into context ──────
        // Mid-run whisper messages from the user land here as system messages.
        // The model sees them at the next model call without the run pausing.
        if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
            let injected: Vec<String> = {
                let mut queues = es.inject_queues.lock();
                queues.remove(session_id).unwrap_or_default()
            };
            for msg in injected {
                info!("[engine] Injecting guidance into round {}: {} chars", round, msg.len());
                messages.push(crate::engine::types::Message {
                    role: crate::engine::types::Role::System,
                    content: crate::engine::types::MessageContent::Text(format!(
                        "⚡ USER MESSAGE — ROUND {} INTERRUPT ⚡\n\
                        The user has sent you a direct message mid-run. \
                        You MUST acknowledge and respond to this BEFORE continuing any other task. \
                        Do not ignore this.\n\n\
                        User says: {}",
                        round, msg
                    )),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    reasoning_content: None,
                });
            }
        }

        // ── Working memory: auto-inject OPIDE_NOTES.md each round ────────────
        // If the session has a workspace path and OPIDE_NOTES.md exists there,
        // inject it as a system message so the agent always knows what it has
        // already investigated — even after context window compression.
        if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
            let notes_path = es
                .session_workspaces
                .lock()
                .get(session_id)
                .map(|wp| std::path::PathBuf::from(wp).join("OPIDE_NOTES.md"));
            if let Some(path) = notes_path {
                if let Ok(notes) = std::fs::read_to_string(&path) {
                    let notes = notes.trim().to_string();
                    if !notes.is_empty() {
                        // Cap at 12 000 chars to avoid blowing the context budget
                        let notes_trimmed = if notes.len() > 12_000 {
                            format!("{}…[truncated — {} chars total]", &notes[..12_000], notes.len())
                        } else {
                            notes.clone()
                        };

                        // On round 1, check file age. If the file was last written more than
                        // 120 seconds ago this run didn't write it — it belongs to a prior
                        // session. Frame it as archived context so the agent doesn't treat
                        // the old task as its current assignment.
                        let file_age_secs = std::fs::metadata(&path)
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.elapsed().ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let is_archive = round == 1 && file_age_secs > 120;

                        let label = if is_archive {
                            format!(
                                "[Prior session findings — archived. Your current task comes \
                                from the user's message above, not this list. Round {}]\n\n{}",
                                round, notes_trimmed
                            )
                        } else {
                            format!(
                                "[Working memory — your OPIDE_NOTES.md, auto-injected at round {}. \
                                Do NOT re-investigate anything marked DONE here.]\n\n{}",
                                round, notes_trimmed
                            )
                        };

                        info!(
                            "[engine] Working memory injected ({} chars) at round {} ({})",
                            notes_trimmed.len(),
                            round,
                            if is_archive { "archive framing" } else { "active framing" }
                        );
                        messages.push(crate::engine::types::Message {
                            role: crate::engine::types::Role::System,
                            content: crate::engine::types::MessageContent::Text(label),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                            reasoning_content: None,
                        });
                    }
                }
            }
        }

        // ── Momentum anchor: keep the agent on track during long audit runs ────
        // Every 10 rounds after round 10, inject a brief "keep going" nudge.
        // This is NOT a restart signal — it frames the injection as continuation,
        // not as a new task. The goal is to prevent the agent from drifting or
        // declaring itself done prematurely, while keeping it focused on areas
        // not yet covered in OPIDE_NOTES.md.
        if round > 10 && round % 10 == 0 {
            let nudge = format!(
                "[MOMENTUM CHECK — round {}] You are mid-investigation. Do NOT restart. \
                Check your OPIDE_NOTES.md (injected above) — anything NOT marked [DONE] \
                still needs investigation. Keep digging into unexplored areas. \
                If all planned areas are DONE, look deeper: entry points, edge cases, \
                cross-contract interactions, access control paths not yet traced.",
                round
            );
            info!("[engine] Momentum anchor injected at round {}", round);
            messages.push(crate::engine::types::Message {
                role: crate::engine::types::Role::System,
                content: crate::engine::types::MessageContent::Text(nudge),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                reasoning_content: None,
            });
        }

        // ── Budget check: stop before making the API call if over daily limit
        if daily_budget_usd > 0.0 {
            if let Some(tracker) = daily_tokens {
                if let Some(spent) = tracker.check_budget(daily_budget_usd) {
                    let msg = format!(
                        "Daily budget exceeded (${:.2} spent of ${:.2} limit). \
                        To continue, go to Settings → Advanced → Daily Budget and increase or clear the limit.",
                        spent, daily_budget_usd
                    );
                    warn!("[engine] {}", msg);
                    fire(
                        app_handle,
                        EngineEvent::Error {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            message: msg.clone(),
                        },
                    );
                    return Err(msg.into());
                }
            }
        }

        // ── 1. Call the AI model (with retry on transient errors) ─────
        // Phase 4: Force tool use on the first round when tools are available.
        // Note: `round` is incremented to 1 at the top of this loop iteration,
        // so the first model call happens with round == 1.
        let tc_override: Option<&str> = if round == 1 && !tools.is_empty() {
            Some("required")
        } else {
            None
        };
        let chunks = {
            let mut last_err = String::new();
            let mut attempt_chunks = None;
            for attempt in 0..3u32 {
                match provider
                    .chat_stream(messages, tools, model, temperature, thinking_level, tc_override)
                    .await
                {
                    Ok(c) => {
                        attempt_chunks = Some(c);
                        break;
                    }
                    Err(e) => {
                        let err_str = e.to_string();
                        let is_transient = err_str.contains("transport error")
                            || err_str.contains("Stream read error")
                            || err_str.contains("connection reset")
                            || err_str.contains("timed out")
                            || err_str.contains("broken pipe")
                            || err_str.contains("status 429")
                            || err_str.contains("status 502")
                            || err_str.contains("status 503")
                            || err_str.contains("status 504");
                        if is_transient && attempt < 2 {
                            let delay = (attempt + 1) as u64 * 2;
                            warn!(
                                "[engine] Transient API error (attempt {}/3): {} — retrying in {}s",
                                attempt + 1, err_str, delay
                            );
                            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                            continue;
                        }
                        last_err = err_str;
                    }
                }
            }
            match attempt_chunks {
                Some(c) => c,
                None => return Err(last_err.into()),
            }
        };

        // ── 2. Assemble the response from chunks ──────────────────────
        let mut text_accum = String::new();
        let mut thinking_accum = String::new();
        let mut tool_call_map: std::collections::HashMap<
            usize,
            (String, String, String, Option<String>, Vec<ThoughtPart>),
        > = std::collections::HashMap::new();
        // (id, name, arguments, thought_signature, thought_parts)
        let mut has_tool_calls = false;

        // Extract the confirmed model name from the API response
        let confirmed_model: Option<String> = chunks.iter().find_map(|c| c.model.clone());

        for chunk in &chunks {
            // Accumulate text deltas
            if let Some(dt) = &chunk.delta_text {
                text_accum.push_str(dt);

                // Phase 3: Emit delta — batched (with binary-ipc) or direct
                #[cfg(feature = "binary-ipc")]
                if let Some(batch) = delta_batcher.push_delta(dt) {
                    fire(
                        app_handle,
                        EngineEvent::Delta {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            text: batch.combined_text,
                        },
                    );
                }
                #[cfg(not(feature = "binary-ipc"))]
                fire(
                    app_handle,
                    EngineEvent::Delta {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        text: dt.clone(),
                    },
                );
            }

            // Emit thinking/reasoning text to frontend and accumulate for history
            if let Some(tt) = &chunk.thinking_text {
                thinking_accum.push_str(tt);
                fire(
                    app_handle,
                    EngineEvent::ThinkingDelta {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        text: tt.clone(),
                    },
                );
            }

            // Accumulate tool call deltas
            for tc_delta in &chunk.tool_calls {
                has_tool_calls = true;
                let entry = tool_call_map.entry(tc_delta.index).or_insert_with(|| {
                    (
                        String::new(),
                        String::new(),
                        String::new(),
                        None,
                        Vec::new(),
                    )
                });

                if let Some(id) = &tc_delta.id {
                    entry.0.push_str(id);
                }
                if let Some(name) = &tc_delta.function_name {
                    entry.1.push_str(name);
                }
                if let Some(args_delta) = &tc_delta.arguments_delta {
                    entry.2.push_str(args_delta);
                }
                if tc_delta.thought_signature.is_some() {
                    entry.3 = tc_delta.thought_signature.clone();
                }
            }

            // Collect thought parts from chunks that have tool calls
            if !chunk.thought_parts.is_empty() {
                // Attach to the first tool call index
                let first_idx = chunk.tool_calls.first().map(|tc| tc.index).unwrap_or(0);
                let entry = tool_call_map.entry(first_idx).or_insert_with(|| {
                    (
                        String::new(),
                        String::new(),
                        String::new(),
                        None,
                        Vec::new(),
                    )
                });
                entry.4.extend(chunk.thought_parts.clone());
            }

            // Track token usage — input tokens reflect the full context sent
            // each round, so we keep only the LAST round's input tokens (not a sum).
            // Output tokens are truly incremental, so we sum those across rounds.
            if let Some(usage) = &chunk.usage {
                last_input_tokens = usage.input_tokens; // overwrite, not accumulate
                total_output_tokens += usage.output_tokens;
            }
        }

        // Gather cache token usage from all chunks for accurate cost tracking
        let round_cache_read: u64 = chunks
            .iter()
            .filter_map(|c| c.usage.as_ref())
            .map(|u| u.cache_read_tokens)
            .sum();
        let round_cache_create: u64 = chunks
            .iter()
            .filter_map(|c| c.usage.as_ref())
            .map(|u| u.cache_creation_tokens)
            .sum();

        // Accumulate cache totals across rounds
        total_cache_read += round_cache_read;
        total_cache_create += round_cache_create;

        // ── Record this round's token usage against the daily budget tracker
        if let Some(tracker) = daily_tokens {
            let round_input = last_input_tokens;
            let round_output = chunks
                .iter()
                .filter_map(|c| c.usage.as_ref())
                .map(|u| u.output_tokens)
                .sum::<u64>();
            tracker.record(
                model,
                round_input,
                round_output,
                round_cache_read,
                round_cache_create,
            );
            let (total_in, total_out, est_usd) = tracker.estimated_spend_usd();
            if round == 1 || round % 5 == 0 {
                log::debug!("[engine] Daily spend: ~${:.2} ({} in / {} out tokens today, cache read={} create={})",
                    est_usd, total_in, total_out, round_cache_read, round_cache_create);
            }

            // ── Budget warnings: emit events at 50%, 75%, 90% thresholds
            if daily_budget_usd > 0.0 {
                if let Some(pct) = tracker.check_budget_warning(daily_budget_usd) {
                    let msg = format!(
                        "Budget warning: {}% of daily budget used (${:.2} of ${:.2})",
                        pct, est_usd, daily_budget_usd
                    );
                    warn!("[engine] {}", msg);
                    fire(
                        app_handle,
                        EngineEvent::Error {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            message: msg,
                        },
                    );
                }
                // B173: separate runaway-spend alarm at 2x budget. Fires
                // every round once the threshold is crossed, since the
                // standard 50/75/90 thresholds are one-shot per session
                // and silent past 90%.
                if let Some(ratio) = tracker.check_runaway(daily_budget_usd) {
                    let msg = format!(
                        "Runaway spend: {:.1}x daily budget (${:.2} of ${:.2}) — review or stop the agent",
                        ratio, est_usd, daily_budget_usd
                    );
                    warn!("[engine] {}", msg);
                    fire(
                        app_handle,
                        EngineEvent::Error {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            message: msg,
                        },
                    );
                }
            }
        }

        // ── 3. If no tool calls, check for JS code blocks or finish ──
        if !has_tool_calls || tool_call_map.is_empty() {
            final_text = text_accum.clone();

            // ── Sandbox enforcement: detect JS code blocks in text ──────
            if sandbox_enforcement::has_sandbox(app_handle) {
                if let Some(js_code) = sandbox_enforcement::extract_js_execution_block(&final_text) {
                    info!("[engine] Detected JS execution block in content — routing to sandbox");

                    let exec_tc = sandbox_enforcement::make_execute_code_call(&js_code);

                    messages.push(Message {
                        role: Role::Assistant,
                        content: MessageContent::Text(text_accum.clone()),
                        tool_calls: Some(vec![exec_tc.clone()]),
                        tool_call_id: None,
                        name: None,
                        reasoning_content: if thinking_accum.is_empty() { None } else { Some(thinking_accum.clone()) },
                    });

                    let result = crate::engine::tools::execute_tool(
                        &exec_tc,
                        app_handle,
                        agent_id,
                    )
                    .await;

                    fire(
                        app_handle,
                        EngineEvent::ToolResultEvent {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            tool_call_id: exec_tc.id.clone(),
                            output: result.output.clone(),
                            success: result.success,
                            duration_ms: None,
                        },
                    );

                    messages.push(Message {
                        role: Role::Tool,
                        content: MessageContent::Text(result.output),
                        tool_calls: None,
                        tool_call_id: Some(exec_tc.id),
                        name: Some("execute_code".to_string()),
                        reasoning_content: None,
                    });

                    continue;
                }
            }

            // ── Phase 4 fabrication prevention: force tool use on early rounds ──
            // If tools are available and this is an early round, the model should
            // be calling tools, not generating text claiming it did. Retry up to
            // 2 times with a forcing system message.
            if !tools.is_empty() && round <= 1 && !final_text.is_empty() && fabrication_retries < 2 {
                warn!(
                    "[engine] Round {} returned text without tool calls but {} tools available — \
                     forcing tool use (retry {}/2)",
                    round,
                    tools.len(),
                    fabrication_retries + 1
                );
                messages.push(Message {
                    role: Role::User,
                    content: MessageContent::Text(
                        "[System]: You responded with text instead of calling a tool. \
                         You MUST call a tool to complete this task. Do not describe what you \
                         would do — actually call the tool now. Do not output conversational \
                         text before the tool call.".to_string()
                    ),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    reasoning_content: None,
                });
                fabrication_retries += 1;
                continue;
            }

            // Retry on malformed tool calls (Gemini JSON issues)
            // Skip retry when constrained decoding is active — the parse failure
            // indicates a deeper issue, not a model formatting mistake.
            let constraint_level =
                crate::engine::constrained::detect_constraints(provider.kind(), model).level;
            let constrained_active =
                constraint_level != crate::engine::constrained::ConstraintLevel::None;
            if !constrained_active
                && helpers::handle_malformed_tool_call(&final_text, messages, round, max_rounds)
            {
                continue;
            }

            // Retry on empty response (nudge with user recap)
            if helpers::handle_empty_response(&final_text, messages, round, max_rounds) {
                continue;
            }

            // Persistent empty → fallback message
            if final_text.is_empty() {
                warn!(
                    "[engine] Model returned empty response (0 chars, 0 tool calls) at round {}",
                    round
                );
                final_text = helpers::empty_response_fallback();
            }

            // Add assistant message to history
            messages.push(Message {
                role: Role::Assistant,
                content: MessageContent::Text(text_accum),
                tool_calls: None,
                tool_call_id: None,
                name: None,
                reasoning_content: if thinking_accum.is_empty() { None } else { Some(thinking_accum.clone()) },
            });

            // ── Phase 3: Flush remaining batched deltas BEFORE Complete ──
            #[cfg(feature = "binary-ipc")]
            {
                if let Some(batch) = delta_batcher.flush() {
                    fire(
                        app_handle,
                        EngineEvent::Delta {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            text: batch.combined_text,
                        },
                    );
                }
                crate::engine::binary_ipc::log_session_stats(&delta_batcher.stats(), 0);
            }

            // Emit completion event
            let usage = if last_input_tokens > 0 || total_output_tokens > 0 {
                Some(TokenUsage {
                    input_tokens: last_input_tokens,
                    output_tokens: total_output_tokens,
                    total_tokens: last_input_tokens + total_output_tokens,
                    cache_creation_tokens: total_cache_create,
                    cache_read_tokens: total_cache_read,
                })
            } else {
                None
            };
            fire(
                app_handle,
                EngineEvent::Complete {
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    text: final_text.clone(),
                    tool_calls_count: 0,
                    usage,
                    model: confirmed_model.clone(),
                    total_rounds: Some(round),
                    max_rounds: Some(max_rounds),
                },
            );

            // ── Telemetry flush (Canvas Phase 5) ──────────────────────
            {
                let total_ms = turn_start.elapsed().as_millis() as u64;
                let llm_ms = total_ms.saturating_sub(tool_duration_total_ms);
                let mut summary = telem_collector.build_summary(
                    last_input_tokens,
                    total_output_tokens,
                    round,
                    tool_call_count,
                );
                summary.total_duration_ms = total_ms;
                summary.llm_duration_ms = llm_ms;
                summary.tool_duration_ms = tool_duration_total_ms;
                summary.cost_usd = crate::engine::types::estimate_cost_usd(
                    model,
                    last_input_tokens,
                    total_output_tokens,
                    total_cache_read,
                    total_cache_create,
                );

                if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
                    telem::persist_summary(&es.store, &summary);
                }
                telem::emit_summary(app_handle, &summary);
            }

            // ── Phase 4: Log speculation stats for the session ────────
            #[cfg(feature = "speculative")]
            crate::engine::speculative::log_session_speculation_stats(&speculation_stats);

            return Ok(final_text);
        }

        // ── 4. Process tool calls ─────────────────────────────────────
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut sorted_indices: Vec<usize> = tool_call_map.keys().cloned().collect();
        sorted_indices.sort();

        for idx in sorted_indices {
            let entry = match tool_call_map.get(&idx) {
                Some(e) => e,
                None => continue, // skip missing indices (shouldn't happen)
            };
            let (id, name, arguments, thought_sig, thoughts) = entry;

            log::debug!(
                "[engine] tool_call_map[{}]: id={:?} name={:?} args_len={}",
                idx,
                id,
                name,
                arguments.len()
            );

            // Generate ID if provider didn't supply one, or if the
            // accumulated ID is suspiciously short (SSE chunk corruption).
            let call_id = if id.is_empty() || (id.len() < 8 && !id.starts_with("call_")) {
                if !id.is_empty() {
                    warn!(
                        "[engine] Replacing suspicious tool_call id '{}' (len={}) with generated UUID",
                        id, id.len()
                    );
                }
                format!("call_{}", uuid::Uuid::new_v4())
            } else {
                id.clone()
            };

            tool_calls.push(ToolCall {
                id: call_id.clone(),
                call_type: "function".into(),
                function: FunctionCall {
                    name: name.clone(),
                    arguments: arguments.clone(),
                },
                thought_signature: thought_sig.clone(),
                thought_parts: thoughts.clone(),
            });
        }

        // Emit intermediate reasoning text to activity feed before tool execution.
        // This gives the UI visibility into what the agent concluded before calling tools,
        // and survives session crashes by recording findings per round.
        if !text_accum.is_empty() {
            fire(
                app_handle,
                EngineEvent::AgentReasoning {
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    round,
                    text: text_accum.clone(),
                },
            );
        }

        // Add assistant message with tool calls to history.
        // reasoning_content MUST be preserved here — models like Kimi require it
        // when replaying history that included thinking in a prior round.
        messages.push(Message {
            role: Role::Assistant,
            content: MessageContent::Text(text_accum),
            tool_calls: Some(tool_calls.clone()),
            tool_call_id: None,
            name: None,
            reasoning_content: if thinking_accum.is_empty() { None } else { Some(thinking_accum.clone()) },
        });

        // ── Repetition detector: break tool-calling loops ──────────────
        // Hash the sorted tool names + full args into a u64 fingerprint.
        // If the same fingerprint appears MAX_REPEATED_SIGNATURES times
        // consecutively, the model is stuck repeating the same tool calls
        // (common when model or context is changed mid-conversation).
        // Uses a hash to avoid UTF-8 boundary issues and keep memory flat.
        {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};

            let mut sig_parts: Vec<(&str, &str)> = tool_calls
                .iter()
                .map(|tc| (tc.function.name.as_str(), tc.function.arguments.as_str()))
                .collect();
            sig_parts.sort();

            let mut hasher = DefaultHasher::new();
            for (name, args) in &sig_parts {
                name.hash(&mut hasher);
                args.hash(&mut hasher);
            }
            let signature = hasher.finish();
            round_signatures.push(signature);

            // Check the last N signatures for consecutive repetition
            let sig_len = round_signatures.len();
            if sig_len >= MAX_REPEATED_SIGNATURES {
                let all_same = round_signatures[sig_len - MAX_REPEATED_SIGNATURES..]
                    .iter()
                    .all(|&s| s == signature);
                if all_same {
                    // Check whether we (or detect_response_loop) already
                    // injected a loop/redirect message. If so, the model
                    // ignored the first nudge — hard-break to prevent
                    // unbounded redirect stacking.
                    let already_redirected = messages.iter().any(|m| {
                        m.role == Role::System && {
                            let t = m.content.as_text_ref();
                            t.contains("stuck in a tool-calling loop")
                                || t.contains("stuck in a response loop")
                                || t.contains("stuck repeating yourself")
                                || t.contains("TOPIC CHANGE")
                                || t.contains("stuck asking clarifying questions")
                        }
                    });
                    if already_redirected {
                        warn!(
                            "[engine] Model ignored tool-loop redirect — hard-breaking agent turn"
                        );
                        messages.pop(); // remove the repeated assistant message
                        return Ok(
                            "I was stuck calling the same tools repeatedly and couldn't make \
                            progress. Please try rephrasing your request or switching context."
                                .to_string(),
                        );
                    }

                    warn!(
                        "[engine] Tool-call loop detected: same tool signature repeated {} times — injecting redirect",
                        MAX_REPEATED_SIGNATURES
                    );
                    // Remove the assistant message we just pushed (it has the repeated tools)
                    messages.pop();
                    // Inject a redirect message
                    messages.push(Message {
                        role: Role::System,
                        content: MessageContent::Text(
                            "[SYSTEM] You are stuck in a tool-calling loop — you have called the \
                            same tools with the same arguments multiple times in a row. STOP calling \
                            tools and provide a direct text response to the user summarizing what you \
                            have accomplished and any issues encountered. Do NOT make any more tool calls."
                                .to_string(),
                        ),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    });
                    continue; // Go back to model call — it should now produce text
                }
            }
        }

        // ── 5. Execute each tool call (with HIL approval) ──────────────
        //
        // Tool tiers (VS Code-inspired, adapted for Pawz multi-capability scope):
        //
        //  T1 — SAFE: Read-only, zero side effects → always auto-approve
        //  T2 — REVERSIBLE: Local writes that can be undone (files, memory, tasks) → auto-approve
        //  T3 — EXTERNAL: Irreversible outbound actions (send email, post to Slack,
        //        create Google docs) → require approval, offer "Always Allow"
        //  T4 — DANGEROUS: Shell exec, financial trades, destructive ops → always prompt
        //
        let tc_count = tool_calls.len();

        // ── Plan interception: if the model called execute_plan, hand off
        // to the DAG executor instead of normal tool-by-tool execution ──
        #[cfg(feature = "plan-executor")]
        if tool_calls.len() == 1 && tool_calls[0].function.name == "execute_plan" {
            let tc = &tool_calls[0];
            info!("[engine] Intercepting execute_plan — routing to DAG executor");

            let args_str = &tc.function.arguments;
            let args: serde_json::Value =
                match serde_json::from_str(if args_str.trim().is_empty() {
                    "{}"
                } else {
                    args_str
                }) {
                    Ok(v) => v,
                    Err(e) => {
                        let err_msg = format!(
                            "Failed to parse execute_plan arguments: {}. \
                         Please provide a valid JSON plan with 'nodes' array.",
                            e
                        );
                        messages.push(Message {
                            role: Role::Tool,
                            content: MessageContent::Text(err_msg),
                            tool_calls: None,
                            tool_call_id: Some(tc.id.clone()),
                            name: Some("execute_plan".to_string()),
                            reasoning_content: None,
                        });
                        continue;
                    }
                };

            // Parse the plan
            let plan = match crate::engine::plan::parse_plan(&args) {
                Ok(p) => p,
                Err(e) => {
                    messages.push(Message {
                        role: Role::Tool,
                        content: MessageContent::Text(format!(
                            "Plan parsing failed: {}. Fix the plan and retry, or call tools individually.",
                            e
                        )),
                        tool_calls: None,
                        tool_call_id: Some(tc.id.clone()),
                        name: Some("execute_plan".to_string()),
                        reasoning_content: None,
                    });
                    continue;
                }
            };

            // Validate against available tools
            let validation_errors = crate::engine::plan::validate_plan(&plan, tools);
            if !validation_errors.is_empty() {
                let err_list: Vec<String> =
                    validation_errors.iter().map(|e| e.to_string()).collect();
                messages.push(Message {
                    role: Role::Tool,
                    content: MessageContent::Text(format!(
                        "Plan validation failed:\n- {}\nFix these issues and retry, or call tools individually.",
                        err_list.join("\n- ")
                    )),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    name: Some("execute_plan".to_string()),
                    reasoning_content: None,
                });
                continue;
            }

            // Execute the plan (parallel DAG execution)
            let results =
                crate::engine::plan::execute_plan(&plan, app_handle, agent_id, session_id, run_id)
                    .await;

            // Build results context for the model
            let results_context = crate::engine::plan::build_results_context(&plan, &results);

            // Track tool calls and timing for telemetry
            let plan_node_count = plan.nodes.len() as u32;
            tool_call_count += plan_node_count;

            messages.push(Message {
                role: Role::Tool,
                content: MessageContent::Text(results_context),
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
                name: Some("execute_plan".to_string()),
                reasoning_content: None,
            });

            // Continue the loop — model will synthesize results into a response
            info!(
                "[engine] Plan execution complete: {} nodes executed, feeding results back to model",
                plan_node_count
            );
            continue;
        }

        // ── Sandbox enforcement: route tools through sandbox when available ──
        let has_sandbox = sandbox_enforcement::has_sandbox(app_handle);

        // Single tool: force non-query IDE tools through sandbox
        if has_sandbox && tool_calls.len() == 1 {
            let tc = &tool_calls[0];
            if sandbox_enforcement::should_force_single_tool(tc) {
                let js_code = sandbox_enforcement::build_single_tool_sandbox_code(tc);
                let batch_tc = sandbox_enforcement::make_execute_code_call(&js_code);
                let result = crate::engine::tools::execute_tool(
                    &batch_tc,
                    app_handle,
                    agent_id,
                )
                .await;

                messages.push(Message {
                    role: Role::Tool,
                    content: MessageContent::Text(result.output),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.function.name.clone()),
                    reasoning_content: None,
                });

                log::debug!(
                    "[engine] Forced IDE tool '{}' through sandbox (single-call enforcement)",
                    tc.function.name
                );
                continue;
            }
        }

        // Multiple tools: batch through sandbox (unless WASM tools present)
        if has_sandbox && sandbox_enforcement::should_batch_tools(&tool_calls) {
            let batch_code = sandbox_enforcement::build_batch_sandbox_code(&tool_calls);
            log::debug!(
                "[engine] Batching {} tool calls through execution engine",
                tool_calls.len()
            );

            // Execute through the sandbox via the execute_code tool
            let batch_args = serde_json::json!({"code": batch_code});
            let batch_tc = crate::engine::types::ToolCall {
                id: format!("batch_{}", uuid::Uuid::new_v4()),
                call_type: "function".into(),
                function: crate::engine::types::FunctionCall {
                    name: "execute_code".to_string(),
                    arguments: serde_json::to_string(&batch_args).unwrap_or_default(),
                },
                thought_signature: None,
                thought_parts: Vec::new(),
            };

            let result = crate::engine::tools::execute_tool(
                &batch_tc,
                app_handle,
                agent_id,
            )
            .await;

            // The assistant message with tool_calls was already pushed earlier in this
            // iteration (in the tool-call collection block above). Do NOT push it again —
            // Kimi and other OpenAI-compatible APIs require exactly one assistant message
            // per set of tool_call_ids, immediately followed by matching tool result messages.

            // Cap batch result size to prevent context blowouts.
            // UTF-8 safe truncation: floor to a char boundary before slicing.
            const MAX_BATCH_RESULT_BYTES: usize = 100_000;
            let mut batch_output = result.output.clone();
            if batch_output.len() > MAX_BATCH_RESULT_BYTES {
                let original_len = batch_output.len();
                let mut cut = MAX_BATCH_RESULT_BYTES;
                while cut > 0 && !batch_output.is_char_boundary(cut) { cut -= 1; }
                batch_output = format!(
                    "{}...\n\n[TRUNCATED: batch result was {} bytes, capped at {}]",
                    &batch_output[..cut],
                    original_len,
                    MAX_BATCH_RESULT_BYTES
                );
                warn!("[engine] Batch result truncated: {} → {} bytes", original_len, MAX_BATCH_RESULT_BYTES);
            }

            // Parse the sandbox batch envelope so per-tool results land on their
            // matching tool_call_id. Envelope shape (see sandbox_enforcement::build_batch_sandbox_code):
            //   { batch: true, count: N, results: [{ tool: "name", result: <any> }, ...] }
            // On any parse failure we fall back to the legacy "first-tool-gets-everything"
            // behaviour so a malformed sandbox response still satisfies the OpenAI
            // "every tool_call_id needs a result" contract.
            #[derive(serde::Deserialize)]
            struct BatchEntry {
                #[allow(dead_code)]
                tool: Option<String>,
                result: serde_json::Value,
            }
            #[derive(serde::Deserialize)]
            struct BatchEnvelope {
                #[serde(default)]
                results: Vec<BatchEntry>,
            }
            let entries: Vec<BatchEntry> = serde_json::from_str::<BatchEnvelope>(&batch_output)
                .map(|e| e.results)
                .unwrap_or_default();

            for (i, tc) in tool_calls.iter().enumerate() {
                let tc_output = if let Some(entry) = entries.get(i) {
                    let mut body = serde_json::to_string_pretty(&entry.result)
                        .unwrap_or_else(|_| entry.result.to_string());
                    // Per-tool cap — combined cap above already applied; this
                    // protects against a single large entry within the envelope.
                    if body.len() > MAX_BATCH_RESULT_BYTES {
                        let body_len = body.len();
                        let mut cut = MAX_BATCH_RESULT_BYTES;
                        while cut > 0 && !body.is_char_boundary(cut) { cut -= 1; }
                        body = format!(
                            "{}...\n\n[TRUNCATED: per-tool result was {} bytes]",
                            &body[..cut], body_len
                        );
                    }
                    body
                } else if i == 0 {
                    // Fallback: parsing failed. Put the whole sandbox output on the first
                    // tool so the agent still sees something useful.
                    batch_output.clone()
                } else {
                    format!("(batched with {} — sandbox output couldn't be split)",
                        tool_calls[0].function.name)
                };

                messages.push(Message {
                    role: Role::Tool,
                    content: MessageContent::Text(tc_output),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.function.name.clone()),
                    reasoning_content: None,
                });
            }

            info!(
                "[engine] Batch execution complete: {} tool calls in one sandbox run (parsed_entries={})",
                tool_calls.len(),
                entries.len()
            );
            continue;
        }

        for tc in &tool_calls {
            let args_preview: String = tc.function.arguments.chars().take(200).collect();
            info!("[engine] Tool call: {} id={} args={}{}", tc.function.name, tc.id, args_preview, if tc.function.arguments.len() > 200 { "..." } else { "" });

            // ─── T1: Safe — read-only / informational (always auto-approve) ───
            let tier1_safe: &[&str] = &[
                "fetch",
                "read_file",
                "list_directory",
                "soul_read",
                "soul_list",
                "memory_search",
                "memory_stats",
                "self_info",
                "web_search",
                "web_read",
                "web_screenshot",
                "web_browse",
                "list_tasks",
                "email_read",
                "slack_read",
                "telegram_read",
                "google_gmail_list",
                "google_gmail_read",
                "google_calendar_list",
                "google_drive_list",
                "google_drive_read",
                "google_sheets_read",
                "sol_balance",
                "sol_quote",
                "sol_portfolio",
                "sol_token_info",
                "dex_balance",
                "dex_quote",
                "dex_portfolio",
                "dex_token_info",
                "dex_check_token",
                "dex_search_token",
                "dex_watch_wallet",
                "dex_whale_transfers",
                "dex_top_traders",
                "dex_trending",
                "coinbase_prices",
                "coinbase_balance",
                "agent_list",
                "agent_skills",
                "agent_read_messages",
                "list_squads",
                "skill_search",
                "skill_list",
                "request_tools",
                "mcp_refresh",
                "search_ncnodes",
                "n8n_list_workflows",
                // Canvas (internal UI — zero side effects)
                "canvas_push",
                "canvas_update",
                "canvas_save",
                "canvas_load",
                "canvas_list_dashboards",
                "canvas_delete_dashboard",
                "canvas_list_templates",
                "canvas_from_template",
                "canvas_create_template",
                "trello_list_boards",
                "trello_get_board",
                "trello_get_lists",
                "trello_get_cards",
                "trello_get_card",
                "trello_search",
                "trello_get_labels",
                "trello_get_members",
                "execute_plan",
            ];

            // ─── T2: Reversible — local writes, can be undone (auto-approve) ───
            //
            // B198: `execute_code` USED to live here on the theory that the
            // sandbox makes it equivalent to individual tool calls. That
            // reasoning was wrong: the sandbox isolates JS from native code
            // but the JS body can call `ctx.tool('ide_run_command', …)` /
            // `ctx.exec(…)` to reach the host shell with full user privilege.
            // A `execute_code` auto-approve at this layer let an agent
            // sneak a `printf 'KEY=…' > /Users/…/Desktop/x` past every other
            // gate in the system. Removed from auto-approve so the user
            // sees and reviews the JS body before it runs (B196 made the
            // sandbox-enforcement layer agree; this completes the fix).
            let tier2_reversible: &[&str] = &[
                "soul_write",
                "memory_store",
                "memory_knowledge",
                "update_profile",
                "create_task",
                "manage_task",
                "write_file",
                "agent_skill_assign",
                "skill_install",
                "agent_send_message",
                "create_squad",
                "manage_squad",
                "squad_broadcast",
            ];

            // ─── T3: External — irreversible outbound actions (prompt, offer Always Allow) ───
            // These leave the user's machine — can't be undone once sent.
            let tier3_external: &[&str] = &[
                "email_send",
                "google_gmail_send",
                "google_docs_create",
                "google_drive_upload",
                "google_drive_share",
                "google_calendar_create",
                "google_sheets_append",
                "google_api",
                "image_generate",
                "trello_create_board",
                "trello_update_board",
                "trello_create_list",
                "trello_update_list",
                "trello_archive_list",
                "trello_create_card",
                "trello_update_card",
                "trello_move_card",
                "trello_add_comment",
                "trello_create_label",
                "trello_update_label",
                "trello_add_label",
                "trello_remove_label",
                "trello_create_checklist",
                "trello_add_checklist_item",
                "trello_toggle_checklist_item",
            ];

            // ─── T4: Dangerous — financial / destructive (always prompt) ───
            // B136: classify file deletion alongside exec/run_command. Without
            // this, `delete_file` / `ide_delete_file` fall through to the
            // default tier and are auto-approved on agents that haven't opted
            // out, which can wipe user files unrecoverably.
            let tier4_dangerous: &[&str] = &[
                "exec",
                "run_command",
                "delete_file",
                "ide_delete_file",
                "sol_swap",
                "sol_transfer",
                "sol_wallet_create",
                "dex_swap",
                "dex_transfer",
                "dex_wallet_create",
                "coinbase_trade",
                "coinbase_transfer",
                "coinbase_wallet_create",
            ];

            // Combined auto-approve set: T1 + T2
            let auto_approved_tools: Vec<&str> = tier1_safe
                .iter()
                .chain(tier2_reversible.iter())
                .copied()
                .collect();

            // Trading write tools check the policy-based approval function
            #[cfg(feature = "trading")]
            let trading_write_tools = tier4_dangerous
                .iter()
                .filter(|t| {
                    t.starts_with("sol_") || t.starts_with("dex_") || t.starts_with("coinbase_")
                })
                .copied()
                .collect::<Vec<&str>>();

            // Determine the tier label for the tool (sent to frontend for UI hints)
            let _tool_tier = if tier1_safe.contains(&tc.function.name.as_str()) {
                "safe"
            } else if tier2_reversible.contains(&tc.function.name.as_str()) {
                "reversible"
            } else if tier3_external.contains(&tc.function.name.as_str()) {
                "external"
            } else if tier4_dangerous.contains(&tc.function.name.as_str()) {
                "dangerous"
            } else {
                "unknown" // MCP/dynamic tools — default to requiring approval
            };

            // ── Circuit breaker: block tools that already hit HARD_STOP ──
            if let Some(count) = tool_fail_counter.get(&tc.function.name) {
                if *count >= HARD_STOP_TOOL_FAILS {
                    warn!(
                        "[engine] Circuit breaker: blocking '{}' (already failed {} times)",
                        tc.function.name, count
                    );
                    messages.push(Message {
                        role: Role::Tool,
                        content: MessageContent::Text(format!(
                            "Error: Tool '{}' is blocked after {} consecutive failures. Use a different tool or tell the user.",
                            tc.function.name, count
                        )),
                        tool_calls: None,
                        tool_call_id: Some(tc.id.clone()),
                        name: Some(tc.function.name.clone()),
                        reasoning_content: None,
                    });
                    continue;
                }
            }

            // Sandboxed tools (IDE, WASM, execute_code) are always auto-approved
            let mut skip_hil = auto_approve_all
                || auto_approved_tools.contains(&tc.function.name.as_str())
                || user_approved_tools.iter().any(|t| t == &tc.function.name)
                || sandbox_enforcement::is_sandbox_auto_approved(tc);

            #[cfg(feature = "trading")]
            if !skip_hil && trading_write_tools.contains(&tc.function.name.as_str()) {
                skip_hil = check_trading_auto_approve(&tc.function.name, &tc.function.arguments, app_handle);
            }

            let approved = if skip_hil {
                // Distinguish agent-level auto-approve from safe-tool auto-approve in logs
                if auto_approve_all && !auto_approved_tools.contains(&tc.function.name.as_str()) {
                    log::debug!(
                        "[engine] Tool auto-approved (agent policy): {}",
                        tc.function.name
                    );
                    // Emit audit event so frontend can track agent-policy approvals
                    fire(
                        app_handle,
                        EngineEvent::ToolAutoApproved {
                            session_id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            tool_name: tc.function.name.clone(),
                            tool_call_id: tc.id.clone(),
                        },
                    );
                } else {
                    log::debug!("[engine] Auto-approved safe tool: {}", tc.function.name);
                }
                // Emit ToolRequest for ALL auto-approved tools so the frontend activity
                // bar can show the tool as running and track duration via activeTools map.
                // Without this, ToolResultEvent arrives but has nothing to update.
                fire(
                    app_handle,
                    EngineEvent::ToolRequest {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        tool_call: tc.clone(),
                        tool_tier: Some(_tool_tier.to_string()),
                        round_number: Some(round),
                        loaded_tools: None,
                        context_tokens: None,
                    },
                );
                true
            } else {
                info!("[engine] Tool requires user approval: {}", tc.function.name);
                // Register a oneshot channel for approval
                let (approval_tx, approval_rx) = tokio::sync::oneshot::channel::<bool>();
                {
                    let mut map = pending_approvals.lock();
                    map.insert(tc.id.clone(), approval_tx);
                }

                // Emit tool request event — frontend will show approval modal
                fire(
                    app_handle,
                    EngineEvent::ToolRequest {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        tool_call: tc.clone(),
                        tool_tier: Some(_tool_tier.to_string()),
                        round_number: Some(round),
                        loaded_tools: None,
                        context_tokens: None,
                    },
                );

                // Wait for user approval (with timeout)
                let timeout_duration = Duration::from_secs(tool_timeout_secs);
                match tokio::time::timeout(timeout_duration, approval_rx).await {
                    Ok(Ok(allowed)) => allowed,
                    Ok(Err(_)) => {
                        warn!("[engine] Approval channel closed for {}", tc.id);
                        false
                    }
                    Err(_) => {
                        warn!(
                            "[engine] Approval timeout ({}s) for tool {}",
                            tool_timeout_secs, tc.function.name
                        );
                        // Clean up the pending entry
                        let mut map = pending_approvals.lock();
                        map.remove(&tc.id);
                        false
                    }
                }
            };

            if !approved {
                info!(
                    "[engine] Tool DENIED by user: {} id={}",
                    tc.function.name, tc.id
                );

                // Audit: log tool denial
                if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
                    crate::engine::audit::log_tool_denied(
                        &es.store,
                        agent_id,
                        session_id,
                        &tc.function.name,
                        &tc.id,
                    );
                }

                // Emit denial as tool result
                fire(
                    app_handle,
                    EngineEvent::ToolResultEvent {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        tool_call_id: tc.id.clone(),
                        output: "Tool execution denied by user.".into(),
                        success: false,
                        duration_ms: None,
                    },
                );

                // Add denial to message history so the model knows
                messages.push(Message {
                    role: Role::Tool,
                    content: MessageContent::Text("Tool execution denied by user.".into()),
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                    name: Some(tc.function.name.clone()),
                    reasoning_content: None,
                });
                continue;
            }

            // Yield to the Tokio scheduler before executing the tool.
            // This gives the Tauri event loop a chance to flush the ToolRequest
            // event to the frontend before ToolResultEvent fires.  Without this
            // yield, fast tools (< ~5ms) can deliver their result before the
            // request — the frontend activeTools map would find no matching entry
            // and fall back to the generic "Done Xms" line (Finding 6).
            tokio::task::yield_now().await;

            // Execute the tool (pass agent_id so tools know which agent is calling)
            let tool_timer = telem::ToolTimer::start(&tc.function.name);
            let result = tools::execute_tool(tc, app_handle, agent_id).await;
            let tool_ms = tool_timer.finish(&telem_collector, &telem_root_id, result.success);
            tool_duration_total_ms += tool_ms;
            tool_call_count += 1;

            // Hard cap on tool result size to prevent context blowouts.
            // 50KB per result — anything larger is truncated. This prevents
            // a single file read or search from consuming the entire context.
            const MAX_TOOL_RESULT_BYTES: usize = 50_000;
            #[allow(unused_mut)]
            let mut result = result;
            if result.output.len() > MAX_TOOL_RESULT_BYTES {
                let truncated_len = result.output.len();
                // Find a valid UTF-8 char boundary at or before the cap
                let mut cut = MAX_TOOL_RESULT_BYTES;
                while cut > 0 && !result.output.is_char_boundary(cut) {
                    cut -= 1;
                }
                result.output = format!(
                    "{}...\n\n[TRUNCATED: result was {} bytes, capped at {}. Use more specific queries.]",
                    &result.output[..cut],
                    truncated_len,
                    MAX_TOOL_RESULT_BYTES
                );
                warn!(
                    "[engine] Tool result truncated: {} was {} bytes → {}",
                    tc.function.name, truncated_len, MAX_TOOL_RESULT_BYTES
                );
            }

            let output_preview: String = result.output.chars().take(200).collect();
            info!(
                "[engine] Tool result: {} success={} output_len={} preview={}{}",
                tc.function.name,
                result.success,
                result.output.len(),
                output_preview,
                if result.output.len() > 200 { "..." } else { "" }
            );

            // Audit: log tool execution result
            if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
                crate::engine::audit::log_tool_call(
                    &es.store,
                    agent_id,
                    session_id,
                    &tc.function.name,
                    &tc.id,
                    &tc.function.arguments,
                    result.success,
                    &result.output,
                );
            }

            // Emit tool result event
            fire(
                app_handle,
                EngineEvent::ToolResultEvent {
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    tool_call_id: tc.id.clone(),
                    output: result.output.clone(),
                    success: result.success,
                    duration_ms: Some(tool_ms),
                },
            );

            // Add tool result to message history
            messages.push(Message {
                role: Role::Tool,
                content: MessageContent::Text(result.output.clone()),
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
                name: Some(tc.function.name.clone()),
                reasoning_content: None,
            });

            // ── Circuit breaker: track consecutive failures per tool ──
            if !result.success {
                let count = tool_fail_counter
                    .entry(tc.function.name.clone())
                    .or_insert(0);
                *count += 1;
                if *count >= HARD_STOP_TOOL_FAILS {
                    warn!(
                        "[engine] Circuit breaker HARD STOP: tool '{}' failed {} consecutive times. Blocking further calls.",
                        tc.function.name, count
                    );
                    messages.push(Message {
                        role: Role::System,
                        content: MessageContent::Text(format!(
                            "[SYSTEM] HARD STOP: The tool '{}' has failed {} times in a row and is now BLOCKED. \
                            Do NOT call '{}' again — it will not work. \
                            Instead, tell the user what happened and suggest they check their \
                            skill configuration or try a different approach. Provide a text summary now.",
                            tc.function.name, count, tc.function.name
                        )),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    });
                } else if *count >= MAX_CONSECUTIVE_TOOL_FAILS {
                    warn!(
                        "[engine] Circuit breaker: tool '{}' failed {} consecutive times. Injecting stop-retry nudge.",
                        tc.function.name, count
                    );
                    messages.push(Message {
                        role: Role::System,
                        content: MessageContent::Text(format!(
                            "[SYSTEM] The tool '{}' has failed {} times in a row. \
                            Stop calling '{}' with the same arguments — try a DIFFERENT tool or approach instead. \
                            Use `request_tools` to discover alternative tools that might work better. \
                            For example, if google_api failed, try dedicated tools like google_docs_create, \
                            google_drive_upload, or google_drive_share instead.",
                            tc.function.name, count, tc.function.name
                        )),
                        tool_calls: None,
                        tool_call_id: None,
                        name: None,
                        reasoning_content: None,
                    });
                }
            } else {
                // Reset counter on success
                tool_fail_counter.remove(&tc.function.name);
            }

            // ── Phase 4: Record tool transition & predict next tool ───
            #[cfg(feature = "speculative")]
            {
                if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
                    let conn = es.store.conn();
                    let db = conn.lock();
                    if let Some(candidate) = crate::engine::speculative::predict_and_record(
                        &db,
                        previous_tool.as_deref(),
                        &tc.function.name,
                        &speculation_config,
                    ) {
                        speculation_stats.predictions += 1;
                        info!(
                            "[speculative] Predicted next tool: {} (p={:.2})",
                            candidate.tool_name, candidate.probability
                        );

                        if speculation_config.warm_connections {
                            if let Some(target) =
                                crate::engine::speculative::warm_target_for_domain(&candidate.tool_name)
                            {
                                if let Ok(dur) = crate::engine::speculative::warm_connection(&target) {
                                    speculation_stats.connections_warmed += 1;
                                    info!(
                                        "[speculative] Pre-warmed connection to {}:{} in {:.1}ms",
                                        target.host,
                                        target.port,
                                        dur.as_secs_f64() * 1000.0
                                    );
                                }
                            }
                        }
                    }
                }
                previous_tool = Some(tc.function.name.clone());
            }
        }

        // ── 6. Tool RAG: refresh tools if request_tools was called ─────
        helpers::refresh_tool_rag(app_handle, tools);

        // ── 7. Mid-loop context truncation ─────────────────────────────
        // §24 Checkpoint: snapshot conversation state before truncation destroys messages
        if let Some(es) = app_handle.try_state::<crate::engine::state::EngineState>() {
            let checkpoint_msgs: Vec<crate::atoms::engram_types::CheckpointMessage> = messages
                .iter()
                .map(|m| crate::atoms::engram_types::CheckpointMessage {
                    role: format!("{:?}", m.role).to_lowercase(),
                    content: match &m.content {
                        MessageContent::Text(t) => t.clone(),
                        MessageContent::Blocks(blocks) => blocks
                            .iter()
                            .filter_map(|b| match b {
                                ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    },
                    timestamp: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                })
                .collect();
            // Capture the live working-memory snapshot. context_continuity's
            // restore path (line 202+) actually reads `working_memory.slots` —
            // passing an empty snapshot here defeats the recovery feature.
            let wm_snapshot = {
                let cognitive_lock = es.get_cognitive_state(agent_id);
                let cognitive = cognitive_lock.lock().await;
                cognitive.working_memory.snapshot()
            };
            // file_hashes is reserved for a future workspace-integrity check.
            // No reader consumes it today; pass empty until the feature lands.
            let empty_hashes = std::collections::HashMap::new();
            let req = crate::engine::engram::context_continuity::CaptureCheckpointRequest {
                agent_id,
                session_id,
                messages: &checkpoint_msgs,
                working_memory: &wm_snapshot,
                file_hashes: &empty_hashes,
                tasks: &[],
                key_decisions: &[],
            };
            if let Err(e) =
                crate::engine::engram::context_continuity::capture_checkpoint(&es.store, &req)
            {
                warn!(
                    "[engine] Failed to capture pre-truncation checkpoint: {}",
                    e
                );
            }
        }
        helpers::truncate_mid_loop(app_handle, messages);

        // ── 8. Loop: send tool results back to model ──────────────────
        log::debug!(
            "[engine] {} tool calls executed, feeding results back to model",
            tc_count
        );

        // NOTE: Do NOT emit Complete here — only emit Complete when the model
        // produces a final text response (no more tool calls). Intermediate
        // Complete events were causing premature stream resolution on the frontend.

        // Continue the loop — model will see tool results and either respond or call more tools
    }
}

// ─── JS Code Block Detection ────────────────────────────────────────────────
// Extracts a `function run(ctx) { ... }` block from LLM text output.
// This catches models that write code blocks instead of using tool calls.

// extract_js_execution_block moved to sandbox_enforcement.rs
